require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Catálogo de serviços para resolver nomes amigáveis
const catalogoServicos = {
  'cilios': 'Cílios (Extensão)',
  'sobrancelha': 'Sobrancelha (Design)',
  'cabelo': 'Cabelo (Corte/Escova)',
  'unha': 'Unhas de Gel',
  '1': 'Cílios (Extensão)',
  '2': 'Sobrancelha (Design)'
};

// ── Webhook Endpoint de Automação ──────────────────────────────────────────────
app.post('/api/webhook/agendamento', async (req, res) => {
  const { cliente, agendamento, metadados } = req.body;
  const timestamp = metadados?.timestamp || new Date().toISOString();
  const origem = metadados?.origem_site || 'Site Principal';

  // 1. Validação de dados recebidos
  if (!cliente || !cliente.nome || !cliente.telefone) {
    const errorMsg = 'Dados do cliente inválidos ou incompletos (nome e telefone são obrigatórios).';
    await db.addLog('error', `[Webhook] Falha de validação: ${errorMsg}`);
    return res.status(400).json({ success: false, error: errorMsg });
  }

  if (!agendamento || !agendamento.servico_id || !agendamento.data || !agendamento.hora) {
    const errorMsg = 'Dados do agendamento incompletos (servico_id, data e hora são obrigatórios).';
    await db.addLog('error', `[Webhook] Falha de validação: ${errorMsg}`);
    return res.status(400).json({ success: false, error: errorMsg });
  }

  const { nome, telefone, email } = cliente;
  const { servico_id, data, hora, status_pix } = agendamento;
  const servico_nome = catalogoServicos[servico_id.toLowerCase()] || `Serviço #${servico_id}`;

  await db.addLog('info', `[Webhook] Recebida nova solicitação para ${nome} (${servico_nome}) em ${data} às ${hora}.`);

  // 2. Validar Pagamento via Pix
  const pixValid = status_pix && (status_pix.toLowerCase() === 'pago' || status_pix.toLowerCase() === 'confirmado');
  if (!pixValid) {
    const msg = `Pagamento Pix não confirmado para ${nome}. Status recebido: "${status_pix || 'ausente'}". Agendamento recusado.`;
    await db.addLog('error', `[Pix] ${msg}`);
    return res.status(400).json({
      success: false,
      error: 'Pagamento Pix não confirmado ou pendente. Por favor, realize o pagamento para agendar.',
      step_failed: 'pix_validation'
    });
  }

  await db.addLog('success', `[Pix] Pagamento Pix de sinal confirmado com sucesso para ${nome}.`);

  try {
    // 3. Verificar Duplicidade/Conflito de Horário (Bloqueio)
    const isDoubleBooked = await db.checkDoubleBooking(data, hora);
    if (isDoubleBooked) {
      const msg = `Conflito de horário detectado: ${data} às ${hora} já está reservado.`;
      await db.addLog('error', `[Agenda] ${msg}`);
      return res.status(409).json({
        success: false,
        error: 'Este dia e horário já estão reservados. Por favor, selecione outro horário.',
        step_failed: 'double_booking'
      });
    }

    // 4. Salvar ou obter Cliente e Confirmar Agendamento no Banco de Dados
    const clienteRow = await db.getOrCreateCliente(nome.trim(), telefone.trim(), email?.trim() || '');
    const novoAgendamento = await db.createAgendamento(
      clienteRow.id,
      servico_id,
      servico_nome,
      data,
      hora,
      status_pix.toLowerCase(),
      origem
    );

    await db.addLog('success', `[Agenda] Horário reservado e agendamento ID #${novoAgendamento.id} gravado no banco.`);
    // 5. Disparar Mensagem de Boas-vindas/Confirmação no WhatsApp
    let whatsappEnviado = false;
    if (process.env.WHATSAPP_SIMULATION !== 'false') {
      const msgWhatsApp = `Olá, ${nome}! ✨ Seu agendamento para *${servico_nome}* no dia *${data}* às *${hora}* foi confirmado com sucesso no Studio Ana Dias. Já recebemos o seu Pix de sinal de 20%. Aguardamos você! 🌸`;
      await db.addLog('success', `[WhatsApp] Mensagem de boas-vindas enviada para +${telefone}. Conteúdo: "${msgWhatsApp}"`);
      whatsappEnviado = true;
    }

    // 6. Adicionar Evento ao Google Calendar
    let calendarAdicionado = false;
    if (process.env.GOOGLE_CALENDAR_SIMULATION !== 'false') {
      await db.addLog('success', `[Google Calendar] Evento adicionado: "Studio Ana Dias - ${servico_nome} (${nome})" em ${data}T${hora}:00.`);
      calendarAdicionado = true;
    }

    return res.status(201).json({
      success: true,
      message: 'Agendamento e pagamento validados e confirmados com sucesso!',
      data: {
        agendamento_id: novoAgendamento.id,
        cliente: clienteRow,
        servico: servico_nome,
        data,
        hora,
        whatsapp_status: whatsappEnviado ? 'disparado' : 'ignorado',
        google_calendar_status: calendarAdicionado ? 'agendado' : 'ignorado'
      }
    });

  } catch (error) {
    const errorMsg = `Erro interno no servidor ao processar o agendamento: ${error.message}`;
    await db.addLog('error', errorMsg);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ── Outros Endpoints para o Dashboard Admin ──────────────────────────────────────
app.get('/api/agendamentos', async (req, res) => {
  try {
    const data = await db.getAgendamentos();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar agendamentos.' });
  }
});

app.delete('/api/agendamentos/:id', async (req, res) => {
  try {
    await db.deleteAgendamento(Number(req.params.id));
    await db.addLog('info', `[Admin] Agendamento ID #${req.params.id} foi cancelado/excluído manualmente.`);
    res.json({ message: 'Agendamento removido com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover agendamento.' });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const data = await db.getLogs();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar logs.' });
  }
});

app.delete('/api/logs', async (req, res) => {
  try {
    await db.clearLogs();
    res.json({ message: 'Logs limpos com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao limpar logs.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const data = await db.getStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
});

// Inicialização
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
