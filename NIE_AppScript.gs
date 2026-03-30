/**
 * NIE – Automação de Prazos Regulatórios
 * Addvalora Brasil
 *
 * RELATÓRIOS AUTOMÁTICOS:
 *  1. Manhã   (~08:00) → Resumo geral do dia para o gestor
 *  2. Meio-dia (~12:00) → Por regulador: o que foi feito + pendências
 *  3. Tarde   (~17:00) → Acompanhamento final do dia por regulador
 *
 * COMO CONFIGURAR OS GATILHOS (Triggers):
 *  - Apps Script → Acionadores (⏰) → Adicionar acionador
 *  - Função: relatórioManha    | Evento: Cronograma diário | Hora: 07:00–08:00
 *  - Função: relatórioMeioDia  | Evento: Cronograma diário | Hora: 12:00–13:00
 *  - Função: relatórioTarde    | Evento: Cronograma diário | Hora: 16:00–17:00
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÕES GLOBAIS
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  // Nome da aba da planilha
  SHEET_NAME: 'Sinistros',

  // ── Colunas da planilha (índice 1 = coluna A) ──
  COL_SITUACAO:     1,   // A: Situação (Aberto/Encerrado)
  COL_STATUS:       2,   // B: Status do processo
  COL_ESCRITORIO:   3,   // C: Escritório
  COL_ADDVALORA:    4,   // D: Ref. Addvalora
  COL_REGULADOR:    5,   // E: Nome do regulador
  COL_SEGURADORA:   7,   // G: Seguradora
  COL_SEGURADO:     9,   // I: Segurado
  COL_DATA_ENTRADA: 11,  // K: Data de entrada
  COL_DATA_VISTORIA:12,  // L: Data da vistoria
  COL_PRAZO_PRELIM: 14,  // N: Prazo para enviar preliminar (fórmula =L+2)
  COL_ENVIO_PRELIM: 17,  // Q: Data do envio do preliminar
  COL_STATUS_PRELIM:19,  // S: Status do preliminar
  COL_DIAS_ABERTOS: 24,  // X: Dias abertos (fórmula)
  COL_DATA_ENT_90D: 30,  // Coluna extra para data entrada do ciclo 90d

  // ── Linha de início dos dados (1=linha de cabeçalho nível 1, 2=cabeçalho nível 2) ──
  LINHA_INICIO_DADOS: 3,

  // ── E-mails ──
  EMAIL_GESTOR: 'victorgabrielkb19@gmail.com',   // Gestor/coordenador que recebe todos os relatórios
  // Mapa de regulador → e-mail (adicione todos os reguladores aqui)
  EMAILS_REGULADORES: {
    'TESTE VICTOR':                               'victorgabrielkb19@gmail.com',
    'Paulo Alexandre Alves Cardoso':              'paulo.cardoso@addvalora.com.br',
    'Jamila Oliveira Luciano':                    'jamila.luciano@addvalora.com.br',
    'Ndongala Garcia Manuel Lufuanquenda':        'ndongala.garcia@addvalora.com.br',
    'Luciano Haas Lucariny':                      'luciano.lucariny@addvalora.com.br',
    'Victor das Neves':                           'victor.neves@addvalora.com.br',
  },

  // ── Limiares de alerta ──
  DIAS_CRITICO: 0,   // prazo já passou (negativo) = crítico
  DIAS_ALERTA:  3,   // vence em até 3 dias
  DIAS_ATENCAO: 7,   // vence em até 7 dias (D+2) ou 15 dias (90d)
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê e retorna todos os dados da planilha como lista de objetos.
 */
function lerProcessos(apenasAbertos = false) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Aba "' + CONFIG.SHEET_NAME + '" não encontrada.');

  const data  = sheet.getDataRange().getValues();
  const hoje  = new Date();
  // Forçar fuso horário de São Paulo/Brasil (GMT-3) para evitar divergências
  const hojeBR = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
  hojeBR.setHours(0, 0, 0, 0);
  
  const processos = [];

  for (let i = CONFIG.LINHA_INICIO_DADOS - 1; i < data.length; i++) {
    const row = data[i];
    const addvalora = row[CONFIG.COL_ADDVALORA - 1];
    if (!addvalora) continue;

    const situacao = String(row[CONFIG.COL_SITUACAO - 1] || '').trim();
    if (apenasAbertos && (situacao.toLowerCase().includes('encerrad') || situacao.toLowerCase().includes('concluíd'))) continue;

    const status       = String(row[CONFIG.COL_STATUS - 1] || '').trim();
    const regulador    = String(row[CONFIG.COL_REGULADOR - 1] || '').trim();
    const seguradora   = String(row[CONFIG.COL_SEGURADORA - 1] || '').trim();
    const segurado     = String(row[CONFIG.COL_SEGURADO - 1] || '').trim();
    const dataEntrada  = parseDataSheet(row[CONFIG.COL_DATA_ENT_90D - 1] || row[CONFIG.COL_DATA_ENTRADA - 1]);
    const dataVistoria = parseDataSheet(row[CONFIG.COL_DATA_VISTORIA - 1]);
    const prazoPrelim  = parseDataSheet(row[CONFIG.COL_PRAZO_PRELIM - 1]);
    const envioPrelim  = parseDataSheet(row[CONFIG.COL_ENVIO_PRELIM - 1]);
    const statusPrelim = String(row[CONFIG.COL_STATUS_PRELIM - 1] || '').trim();
    const diasAbertos  = row[CONFIG.COL_DIAS_ABERTOS - 1];

    let diasParaPrazo = null;
    let dataP = null;
    
    // Prioridade 1: Prazo D+2
    if (prazoPrelim) {
      dataP = new Date(prazoPrelim);
      dataP.setHours(0,0,0,0);
      diasParaPrazo = Math.floor((dataP - hojeBR) / (1000 * 60 * 60 * 24));
    } else if (dataVistoria) {
      dataP = somarDiasUteis(dataVistoria, 2);
      dataP.setHours(0,0,0,0);
      diasParaPrazo = Math.floor((dataP - hojeBR) / (1000 * 60 * 60 * 24));
    }

    let urgD2 = 'ok';
    if (diasParaPrazo !== null) {
      if (diasParaPrazo < 0)  urgD2 = 'critico';
      else if (diasParaPrazo <= CONFIG.DIAS_ALERTA)  urgD2 = 'alerta';
      else if (diasParaPrazo <= CONFIG.DIAS_ATENCAO) urgD2 = 'atencao';
    }
    
    // Regra 2: Ciclo 90 dias
    let urg90 = 'ok';
    if (dataEntrada) {
      const prazo90 = new Date(dataEntrada);
      prazo90.setDate(prazo90.getDate() + 90);
      prazo90.setHours(0,0,0,0);
      const diff90 = Math.floor((prazo90 - hojeBR) / (1000 * 60 * 60 * 24));
      
      if (diff90 < 0) urg90 = 'critico';
      else if (diff90 <= 5) urg90 = 'alerta';
      else if (diff90 <= 15) urg90 = 'atencao';
    }

    // Define o alerta final como o mais urgente dos dois
    const order = { 'critico': 3, 'alerta': 2, 'atencao': 1, 'ok': 0, 'encerrado': -1 };
    let alerta = order[urg90] > order[urgD2] ? urg90 : urgD2;

    let prelimEnviadoHoje = false;
    if (envioPrelim instanceof Date) {
      const ep = new Date(envioPrelim);
      ep.setHours(0,0,0,0);
      prelimEnviadoHoje = ep.getTime() === hojeBR.getTime();
    }

    processos.push({
      addvalora:       String(addvalora).trim(),
      situacao,
      status,
      regulador,
      seguradora,
      segurado,
      dataEntrada:     dataEntrada instanceof Date ? dataEntrada : null,
      dataVistoria:    dataVistoria instanceof Date ? dataVistoria : null,
      prazoPrelim:     dataP,
      envioPrelim:     envioPrelim instanceof Date ? envioPrelim : null,
      statusPrelim,
      diasAbertos:     typeof diasAbertos === 'number' ? diasAbertos : null,
      diasParaPrazo,
      alerta,
      prelimEnviadoHoje,
    });
  }
  return processos;
}

function fmtData(d) {
  if (!d) return '—';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

function somarDiasUteis(data, dias) {
  const d = new Date(data);
  let cont = 0;
  while (cont < dias) {
    d.setDate(d.getDate() + 1);
    const diaSemana = d.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) cont++;
  }
  return d;
}

/**
 * Tenta converter valor da planilha em objeto Date real.
 */
function parseDataSheet(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    // Tenta formato DD/MM/YYYY
    const partes = v.split('/');
    if (partes.length === 3) {
      return new Date(partes[2], partes[1] - 1, partes[0]);
    }
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'number') {
    // Datas no Excel/Sheets podem vir como números seriais
    return new Date((v - 25569) * 86400000);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELATÓRIOS
// ─────────────────────────────────────────────────────────────────────────────

function relatórioManha() {
  const processos = lerProcessos(true);
  const hoje = new Date();
  const dataFmt = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  if (processos.length === 0) {
    MailApp.sendEmail({
      to: CONFIG.EMAIL_GESTOR,
      subject: `[NIE] Relatório Manhã ${dataFmt} — Nenhum processo aberto`,
      htmlBody: `<p>Bom dia! Não há processos abertos na planilha hoje (${dataFmt}).</p>`
    });
    return;
  }

  const criticos  = processos.filter(p => p.alerta === 'critico');
  const alertas   = processos.filter(p => p.alerta === 'alerta');
  const atencoes  = processos.filter(p => p.alerta === 'atencao');
  const oks       = processos.filter(p => p.alerta === 'ok');
  
  const porRegulador = {};
  processos.forEach(p => {
    const reg = p.regulador || '(sem regulador)';
    if (!porRegulador[reg]) porRegulador[reg] = [];
    porRegulador[reg].push(p);
  });

  let html = `
  <div style="font-family:Arial,sans-serif;max-width:750px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#003B5C,#005A8E);padding:24px 28px;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:1.3rem">☀️ Relatório da Manhã — NIE</h1>
      <p style="color:rgba(255,255,255,0.75);margin:6px 0 0;font-size:0.85rem">${dataFmt} · Controle de Prazos Regulatórios</p>
    </div>
    <div style="background:#f4f6f9;padding:20px 28px;display:flex;gap:12px;flex-wrap:wrap">
      ${kpiBox('📁', 'Total Abertos', processos.length, '#003B5C')}
      ${kpiBox('🔴', 'Críticos', criticos.length, '#DA291C')}
      ${kpiBox('🟡', 'Em Alerta', alertas.length, '#d97706')}
      ${kpiBox('🟠', 'Atenção', atencoes.length, '#EF8200')}
    </div>
    ${criticos.length > 0 ? `<div style="background:#fff5f5;border-left:5px solid #DA291C;padding:18px 24px;margin-bottom:15px">
      <h2 style="color:#DA291C;margin:0 0 12px;font-size:1rem">🔴 PROCESSOS CRÍTICOS (${criticos.length})</h2>
      ${tabelaProcessos(criticos)}
    </div>` : ''}
    ${alertas.length > 0 ? `<div style="background:#fffbeb;border-left:5px solid #d97706;padding:18px 24px;margin-bottom:15px">
      <h2 style="color:#92400e;margin:0 0 12px;font-size:1rem">🟡 EM ALERTA (${alertas.length})</h2>
      ${tabelaProcessos(alertas)}
    </div>` : ''}
    ${atencoes.length > 0 ? `<div style="background:#fff7ed;border-left:5px solid #EF8200;padding:18px 24px;margin-bottom:15px">
      <h2 style="color:#c2410c;margin:0 0 12px;font-size:1rem">🟠 EM ATENÇÃO (${atencoes.length})</h2>
      ${tabelaProcessos(atencoes)}
    </div>` : ''}
    <div style="background:#003B5C;color:rgba(255,255,255,0.6);padding:14px 24px;border-radius:0 0 12px 12px;text-align:center;font-size:0.75rem">
      Relatório gerado automaticamente em ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm')} · NIE
    </div>
  </div>`;

  MailApp.sendEmail({ to: CONFIG.EMAIL_GESTOR, subject: `[NIE] Relatório Manhã ${dataFmt}`, htmlBody: html });
}

function relatórioMeioDia() {
  const processos = lerProcessos(true);
  const hoje = new Date();
  const dataFmt = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  if (processos.length === 0) return;

  const porRegulador = {};
  processos.forEach(p => {
    const reg = p.regulador || '(sem regulador)';
    if (!porRegulador[reg]) porRegulador[reg] = [];
    porRegulador[reg].push(p);
  });

  Object.entries(porRegulador).forEach(([regulador, ps]) => {
    const emailReg = CONFIG.EMAILS_REGULADORES[regulador];
    if (!emailReg) return;

    const entreguesHoje = ps.filter(p => p.prelimEnviadoHoje);
    const pendentes = ps.filter(p => !p.prelimEnviadoHoje && (p.alerta === 'critico' || p.alerta === 'alerta'));
    const atencoes  = ps.filter(p => !p.prelimEnviadoHoje && p.alerta === 'atencao');

    let htmlReg = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#003B5C,#005A8E);padding:22px 26px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:1.2rem">🕛 Acompanhamento do Meio-Dia</h1>
        <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:0.85rem">Olá, ${regulador.split(' ')[0]}! · ${dataFmt}</p>
      </div>
      <div style="background:#f4f6f9;padding:16px 24px;display:flex;gap:10px;flex-wrap:wrap">
        ${kpiBox('📁', 'Processos', ps.length, '#003B5C')}
        ${kpiBox('✅', 'Entregues Hoje', entreguesHoje.length, '#16a34a')}
        ${kpiBox('🔴', 'Pendentes', pendentes.length, '#DA291C')}
        ${kpiBox('🟠', 'Em Atenção', atencoes.length, '#EF8200')}
      </div>
      
      ${pendentes.length > 0 ? `
      <div style="background:#fff5f5;border-left:5px solid #DA291C;padding:16px 22px;margin-bottom:15px">
        <h2 style="color:#DA291C;margin:0 0 10px;font-size:0.95rem">⚠️ PENDÊNCIAS CRÍTICAS (${pendentes.length})</h2>
        ${tabelaProcessos(pendentes)}
      </div>` : ''}

      ${atencoes.length > 0 ? `
      <div style="background:#fffbeb;border-left:5px solid #EF8200;padding:16px 22px;margin-bottom:15px">
        <h2 style="color:#92400e;margin:0 0 10px;font-size:0.95rem">🟠 EM ATENÇÃO (${atencoes.length})</h2>
        ${tabelaProcessos(atencoes)}
      </div>` : ''}

      <div style="background:#003B5C;color:rgba(255,255,255,0.6);padding:14px 24px;border-radius:0 0 12px 12px;text-align:center;font-size:0.75rem">
        Relatório gerado em ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm')} · NIE
      </div>
    </div>`;

    MailApp.sendEmail({ to: emailReg, cc: CONFIG.EMAIL_GESTOR, subject: `[NIE] Acompanhamento Meio-Dia ${dataFmt}`, htmlBody: htmlReg });
  });
}

function relatórioTarde() {
  const processos = lerProcessos(true);
  const hoje = new Date();
  const dataFmt = Utilities.formatDate(hoje, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  if (processos.length === 0) return;

  const porRegulador = {};
  processos.forEach(p => {
    const reg = p.regulador || '(sem regulador)';
    if (!porRegulador[reg]) porRegulador[reg] = [];
    porRegulador[reg].push(p);
  });

  Object.entries(porRegulador).forEach(([regulador, ps]) => {
    const emailReg = CONFIG.EMAILS_REGULADORES[regulador];
    if (!emailReg) return;

    const entreguesHoje = ps.filter(p => p.prelimEnviadoHoje);
    const pendentes = ps.filter(p => !p.prelimEnviadoHoje && (p.alerta === 'critico' || p.alerta === 'alerta'));
    const atencoes  = ps.filter(p => !p.prelimEnviadoHoje && p.alerta === 'atencao');

    let htmlReg = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#003B5C,#005A8E);padding:22px 26px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:1.2rem">🌇 Encerramento do Dia — NIE</h1>
        <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:0.85rem">${dataFmt} · Olá, ${regulador.split(' ')[0]}!</p>
      </div>
      <div style="background:#f4f6f9;padding:16px 24px;display:flex;gap:10px;flex-wrap:wrap">
        ${kpiBox('✅', 'Concluídos Hoje', entreguesHoje.length, '#16a34a')}
        ${kpiBox('🔴', 'Pendentes', pendentes.length, '#DA291C')}
        ${kpiBox('🟠', 'Em Atenção', atencoes.length, '#EF8200')}
      </div>

      ${entreguesHoje.length > 0 ? `
      <div style="background:#f0fdf4;border-left:5px solid #16a34a;padding:16px 22px;margin-bottom:15px">
        <h2 style="color:#15803d;margin:0 0 10px;font-size:0.95rem">✅ CONCLUÍDO HOJE (${entreguesHoje.length})</h2>
        ${tabelaProcessos(entreguesHoje)}
      </div>` : ''}

      ${pendentes.length > 0 ? `
      <div style="background:#fff5f5;border-left:5px solid #DA291C;padding:16px 22px;margin-bottom:15px">
        <h2 style="color:#DA291C;margin:0 0 10px;font-size:0.95rem">🔴 PENDENTE PARA AMANHÃ (${pendentes.length})</h2>
        ${tabelaProcessos(pendentes)}
      </div>` : ''}

      ${atencoes.length > 0 ? `
      <div style="background:#fffbeb;border-left:5px solid #EF8200;padding:16px 22px;margin-bottom:15px">
        <h2 style="color:#92400e;margin:0 0 10px;font-size:0.95rem">🟠 EM ATENÇÃO (${atencoes.length})</h2>
        ${tabelaProcessos(atencoes)}
      </div>` : ''}

      <div style="background:#003B5C;color:rgba(255,255,255,0.6);padding:14px 24px;border-radius:0 0 12px 12px;text-align:center;font-size:0.75rem">
        Relatório gerado em ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm')} · NIE
      </div>
    </div>`;

    MailApp.sendEmail({ to: emailReg, cc: CONFIG.EMAIL_GESTOR, subject: `[NIE] Encerramento do Dia ${dataFmt}`, htmlBody: htmlReg });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS HTML
// ─────────────────────────────────────────────────────────────────────────────
function kpiBox(emoji, label, val, cor) {
  return `
    <div style="background:#fff;border-radius:10px;padding:12px 16px;min-width:100px;border-left:4px solid ${cor};box-shadow:0 2px 8px rgba(0,0,0,0.07);margin-bottom:10px">
      <div style="font-size:1.5rem;font-weight:800;color:${cor}">${val}</div>
      <div style="font-size:0.7rem;color:#5B6770;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">${emoji} ${label}</div>
    </div>`;
}

function tabelaProcessos(ps) {
  if (!ps || ps.length === 0) return '<p style="color:#aaa;font-size:0.82rem">Nenhum processo.</p>';
  const linhas = ps.map((p, i) => {
    let statusTexto = '—';
    let corStatus = '#16a34a'; // Verde por padrão

    if (p.diasParaPrazo !== null && p.diasParaPrazo !== undefined) {
      if (p.diasParaPrazo < 0) {
        statusTexto = 'VENCIDO';
        corStatus = '#DA291C'; // Vermelho
      } else if (p.diasParaPrazo <= 3) {
        statusTexto = p.diasParaPrazo + 'd rest.';
        corStatus = '#d97706'; // Amarelo/Laranja (Alerta)
      } else if (p.diasParaPrazo <= 7) {
        statusTexto = p.diasParaPrazo + 'd rest.';
        corStatus = '#EF8200'; // Laranja (Atenção)
      } else {
        statusTexto = p.diasParaPrazo + 'd rest.';
        corStatus = '#16a34a'; // Verde (OK)
      }
    } else {
      statusTexto = 'Aguard. Prazo';
      corStatus = '#5B6770'; // Cinza
    }

    // Sobrescrever cor se for alerta do ciclo 90 dias (que pode ter prazos diferentes)
    if (p.alerta === 'critico') corStatus = '#DA291C';
    else if (p.alerta === 'alerta') corStatus = '#d97706';
    else if (p.alerta === 'atencao') corStatus = '#EF8200';

    return `
    <tr style="background:${i % 2 === 0 ? '#fafafa' : '#fff'}">
      <td style="padding:7px 10px;font-weight:700;color:#003B5C;font-size:0.78rem">${p.addvalora}</td>
      <td style="padding:7px 10px;font-size:0.78rem">${(p.segurado || '—').substring(0, 35)}</td>
      <td style="padding:7px 10px;font-size:0.75rem">${fmtData(p.prazoPrelim)}</td>
      <td style="padding:7px 10px;font-size:0.75rem;font-weight:700;color:${corStatus}">${statusTexto}</td>
    </tr>`;
  }).join('');

  return `
  <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
    <thead>
      <tr style="background:#003B5C;color:#fff">
        <th style="padding:7px 10px;text-align:left">Ref.</th>
        <th style="padding:7px 10px;text-align:left">Segurado</th>
        <th style="padding:7px 10px;text-align:left">Prazo</th>
        <th style="padding:7px 10px;text-align:left">Status</th>
      </tr>
    </thead>
    <tbody>${linhas}</tbody>
  </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MENU E WEBAPP
// ─────────────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚙️ Automação NIE')
    .addItem('▶ Relatório Manhã', 'relatórioManha')
    .addItem('▶ Relatório Meio-Dia', 'relatórioMeioDia')
    .addItem('▶ Relatório Tarde', 'relatórioTarde')
    .addSeparator()
    .addItem('🔄 Atualizar Dados Baruc', 'atualizarDadosBaruc')
    .addToUi();
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({status:'error', message:'Aba Sinistros não encontrada'}));

    // Mapeia linhas existentes pela Ref Addvalora (Coluna D)
    const existingData = sheet.getDataRange().getValues();
    const map = new Map();
    for(let i = CONFIG.LINHA_INICIO_DADOS - 1; i < existingData.length; i++) {
      const ref = String(existingData[i][CONFIG.COL_ADDVALORA - 1] || '').trim();
      if (ref) map.set(ref, i + 1);
    }

    const parseDate = (v) => v ? new Date(v) : null;

    data.forEach(row => {
      const ref = String(row.addvalora).trim();
      let rowNum;
      
      if (map.has(ref)) {
        rowNum = map.get(ref);
      } else {
        // Se não existe, adiciona no final
        sheet.appendRow(new Array(30).fill(''));
        rowNum = sheet.getLastRow();
      }

      // Preenche as colunas conforme CONFIG
      sheet.getRange(rowNum, CONFIG.COL_SITUACAO).setValue(row.situacao);
      sheet.getRange(rowNum, CONFIG.COL_STATUS).setValue(row.status);
      sheet.getRange(rowNum, CONFIG.COL_ESCRITORIO).setValue(row.escritorio);
      sheet.getRange(rowNum, CONFIG.COL_ADDVALORA).setValue(ref);
      sheet.getRange(rowNum, CONFIG.COL_REGULADOR).setValue(row.regulador);
      sheet.getRange(rowNum, CONFIG.COL_SEGURADORA).setValue(row.seguradora);
      sheet.getRange(rowNum, CONFIG.COL_SEGURADO).setValue(row.segurado);
      
      // Datas (precisam ser objetos Date para o Sheets formatar correto)
      if (row.data_entrada)  sheet.getRange(rowNum, CONFIG.COL_DATA_ENTRADA).setValue(parseDate(row.data_entrada));
      if (row.data_vistoria) sheet.getRange(rowNum, CONFIG.COL_DATA_VISTORIA).setValue(parseDate(row.data_vistoria));
      if (row.prazo_d2)      sheet.getRange(rowNum, CONFIG.COL_PRAZO_PRELIM).setValue(parseDate(row.prazo_d2));
      if (row.data_envio_prelim) sheet.getRange(rowNum, CONFIG.COL_ENVIO_PRELIM).setValue(parseDate(row.data_envio_prelim));
      
      // Salva data entrada ciclo 90d na coluna 30
      if (row.data_entrada)  sheet.getRange(rowNum, CONFIG.COL_DATA_ENT_90D).setValue(parseDate(row.data_entrada));
      
      sheet.getRange(rowNum, CONFIG.COL_STATUS_PRELIM).setValue(row.status_prelim);
      if (row._diasAbertos) sheet.getRange(rowNum, CONFIG.COL_DIAS_ABERTOS).setValue(row._diasAbertos);
    });

    return ContentService.createTextOutput(JSON.stringify({status:'ok', count: data.length}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({status:'error', message: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function atualizarDadosBaruc() {
  SpreadsheetApp.getUi().alert('Função para processar aba Importação Baruc executada.');
}
