require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'studio-ana-dias-super-secret-key-2026';

app.use(cors());
// Aumentar o limite de tamanho do JSON para suportar imagens em Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Middleware de Autenticação de Administrador
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido ou inválido.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.adminId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada ou token inválido. Faça login novamente.' });
  }
}

// ── Rota de Login Administrativo ──────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  try {
    const admin = await db.getAdminByUsername(username.trim());
    if (!admin) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    const isValid = bcrypt.compareSync(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: admin.username });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao autenticar.' });
  }
});

// Verificar se token ainda é válido
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
  res.json({ valid: true });
});

// ── Endpoint público: Slots disponíveis por semana ───────────────────────────
// Horário de funcionamento (pode ser ajustado no futuro via painel)
const HORARIOS = ['09:00','10:00','11:00','12:00','14:00','15:00','16:00','17:00','18:00'];
const DIAS_SEMANA_TRABALHO = [1, 2, 3, 4, 5, 6]; // Seg a Sáb (0=Dom)

/**
 * GET /api/slots?week_start=YYYY-MM-DD
 * Retorna os horários disponíveis e ocupados para cada dia da semana dada.
 * Se week_start não for informado, usa a semana atual.
 * Se a semana estiver completamente cheia, sugere a próxima semana disponível.
 */
app.get('/api/slots', async (req, res) => {
  try {
    // Montar datas da semana requisitada
    let weekStart;
    if (req.query.week_start) {
      weekStart = new Date(req.query.week_start + 'T00:00:00');
    } else {
      weekStart = new Date();
      weekStart.setHours(0, 0, 0, 0);
    }

    // Garantir que começa na segunda-feira da semana
    const dayOfWeek = weekStart.getDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    weekStart.setDate(weekStart.getDate() + diffToMonday);

    // Gerar os 6 dias (Seg-Sáb)
    const weekDays = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const iso = d.toISOString().split('T')[0];
      weekDays.push({ date: iso, dateObj: d });
    }

    // Buscar agendamentos da semana toda de uma vez
    const startStr = weekDays[0].date;
    const endStr   = weekDays[weekDays.length - 1].date;
    const booked = await db.getBookedSlots(startStr, endStr);

    // Construir set de ocupados: "YYYY-MM-DD|HH:MM"
    const bookedSet = new Set(booked.map(b => `${b.data}|${b.hora}`));

    // Construir resposta por dia
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totalAvailable = 0;
    const days = weekDays.map(({ date, dateObj }) => {
      const isPast = dateObj < today;
      const isToday = dateObj.getTime() === today.getTime();

      const slots = HORARIOS.map(hora => {
        const key = `${date}|${hora}`;
        const isBooked = bookedSet.has(key);

        // Para o dia atual, bloquear horários que já passaram
        let isPastSlot = false;
        if (isToday) {
          const [h, m] = hora.split(':').map(Number);
          const slotTime = new Date();
          slotTime.setHours(h, m, 0, 0);
          isPastSlot = slotTime <= new Date();
        }

        const available = !isPast && !isBooked && !isPastSlot;
        if (available) totalAvailable++;

        return { hora, available, booked: isBooked };
      });

      return {
        date,
        label: dateObj.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        weekday: dateObj.toLocaleDateString('pt-BR', { weekday: 'long' }),
        isPast,
        slots
      };
    });

    // Se a semana estiver totalmente esgotada, calcular a próxima semana disponível
    let nextAvailableWeek = null;
    if (totalAvailable === 0) {
      const next = new Date(weekStart);
      next.setDate(next.getDate() + 7);
      nextAvailableWeek = next.toISOString().split('T')[0];
    }

    // Datas de navegação
    const prevWeek = new Date(weekStart);
    prevWeek.setDate(prevWeek.getDate() - 7);

    const nextWeek = new Date(weekStart);
    nextWeek.setDate(nextWeek.getDate() + 7);

    res.json({
      week_start: weekStart.toISOString().split('T')[0],
      prev_week:  prevWeek.toISOString().split('T')[0],
      next_week:  nextWeek.toISOString().split('T')[0],
      total_available: totalAvailable,
      next_available_week: nextAvailableWeek,
      days
    });

  } catch (err) {
    console.error('Erro em /api/slots:', err);
    res.status(500).json({ error: 'Erro ao buscar horários disponíveis.' });
  }
});



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

  try {
    // Buscar serviço no banco pelo ID ou nome
    let servico_nome = `Serviço #${servico_id}`;
    const servico = await db.getServicoById(Number(servico_id)).catch(() => null);
    if (servico) {
      servico_nome = servico.nome;
    }

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

// ── Serviços Endpoints ────────────────────────────────────────────────────────
app.get('/api/servicos', async (req, res) => {
  try {
    const data = await db.getServicos();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar serviços.' });
  }
});

app.post('/api/servicos', authenticateAdmin, async (req, res) => {
  const { nome, preco, duracao_min, descricao, imagem } = req.body;
  if (!nome || !preco || !duracao_min) {
    return res.status(400).json({ error: 'Nome, preço e duração são obrigatórios.' });
  }
  try {
    const s = await db.createServico(nome, Number(preco), Number(duracao_min), descricao, imagem || null);
    await db.addLog('info', `[Serviços] Novo serviço cadastrado: "${nome}"`);
    res.status(201).json(s);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar serviço.' });
  }
});

app.put('/api/servicos/:id', authenticateAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { nome, preco, duracao_min, descricao, imagem } = req.body;
  if (!nome || !preco || !duracao_min) {
    return res.status(400).json({ error: 'Nome, preço e duração são obrigatórios.' });
  }
  try {
    await db.updateServico(id, nome, Number(preco), Number(duracao_min), descricao, imagem || null);
    await db.addLog('info', `[Serviços] Serviço ID #${id} atualizado: "${nome}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar serviço.' });
  }
});

app.delete('/api/servicos/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.deleteServico(Number(req.params.id));
    await db.addLog('info', `[Serviços] Serviço ID #${req.params.id} removido.`);
    res.json({ message: 'Serviço removido com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover serviço.' });
  }
});

// ── Portfólio (Antes/Depois) Endpoints ─────────────────────────────────────────
app.get('/api/portfolio', async (req, res) => {
  try {
    const data = await db.getPortfolio();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar portfólio.' });
  }
});

app.post('/api/portfolio', authenticateAdmin, async (req, res) => {
  const { titulo, imagem_antes, imagem_depois } = req.body;
  if (!titulo || !imagem_antes || !imagem_depois) {
    return res.status(400).json({ error: 'Título, foto de Antes e foto de Depois são obrigatórios.' });
  }
  try {
    const item = await db.createPortfolioItem(titulo, imagem_antes, imagem_depois);
    await db.addLog('info', `[Portfólio] Nova foto de portfólio adicionada: "${titulo}"`);
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar item ao portfólio.' });
  }
});

app.delete('/api/portfolio/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.deletePortfolioItem(Number(req.params.id));
    await db.addLog('info', `[Portfólio] Foto de portfólio ID #${req.params.id} excluída.`);
    res.json({ message: 'Item removido do portfólio.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar item do portfólio.' });
  }
});

// ── Agendamentos e Logs Endpoints (Protegidos) ──────────────────────────────────
app.get('/api/agendamentos', authenticateAdmin, async (req, res) => {
  try {
    const data = await db.getAgendamentos();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar agendamentos.' });
  }
});

app.delete('/api/agendamentos/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.deleteAgendamento(Number(req.params.id));
    await db.addLog('info', `[Admin] Agendamento ID #${req.params.id} foi excluído manualmente.`);
    res.json({ message: 'Agendamento removido com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover agendamento.' });
  }
});

app.get('/api/logs', authenticateAdmin, async (req, res) => {
  try {
    const data = await db.getLogs();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar logs.' });
  }
});

app.delete('/api/logs', authenticateAdmin, async (req, res) => {
  try {
    await db.clearLogs();
    res.json({ message: 'Logs limpos.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao limpar logs.' });
  }
});

app.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const data = await db.getStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
});

// Servir páginas HTML específicas caso necessário
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Inicialização
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
