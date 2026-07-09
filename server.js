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

// Alterar senha de administrador (logado via JWT)
app.post('/api/admin/change-password', authenticateAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const admin = await db.getAdminById(req.adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Administrador não encontrado.' });
    }

    const isValid = bcrypt.compareSync(currentPassword, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Senha atual incorreta. Verifique e tente novamente.' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);

    // 1. Salva no banco de dados local
    await db.updateAdminPassword(admin.username, newHash);

    // 2. Persiste no Render via API para sobreviver a redeploys
    let renderSynced = false;
    const renderApiKey = process.env.RENDER_API_KEY;
    const renderServiceId = process.env.RENDER_SERVICE_ID;

    if (renderApiKey && renderServiceId) {
      try {
        const https = require('https');
        const body = JSON.stringify([{ key: 'ADMIN_PASSWORD_HASH', value: newHash }]);
        const options = {
          hostname: 'api.render.com',
          path: `/v1/services/${renderServiceId}/env-vars`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${renderApiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        };
        await new Promise((resolve) => {
          const request = https.request(options, (r) => {
            r.on('data', () => {});
            r.on('end', () => { renderSynced = r.statusCode < 300; resolve(); });
          });
          request.on('error', resolve);
          request.write(body);
          request.end();
        });
      } catch (e) {
        console.warn('[Render API] Falha ao sincronizar senha:', e.message);
      }
    }

    await db.addLog('info', `[Admin] Senha de "${admin.username}" alterada. Render sincronizado: ${renderSynced}`);
    res.json({
      success: true,
      message: 'Senha alterada com sucesso.' + (renderSynced ? ' Senha persistida no Render ✅' : ''),
      renderSynced
    });
  } catch (err) {
    console.error('Erro ao alterar senha:', err);
    res.status(500).json({ error: 'Erro ao alterar a senha.' });
  }
});

// Obter perfil do administrador logado
app.get('/api/admin/profile', authenticateAdmin, async (req, res) => {
  try {
    const admin = await db.getAdminById(req.adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Administrador não encontrado.' });
    }
    res.json({
      id: admin.id,
      username: admin.username,
      email: admin.email || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

// Atualizar perfil (e-mail) do administrador logado
app.post('/api/admin/profile', authenticateAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'O e-mail é obrigatório.' });
  }
  try {
    const admin = await db.getAdminById(req.adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Administrador não encontrado.' });
    }
    
    // Atualizar no banco
    await db.updateAdminProfile(req.adminId, email.trim());
    await db.addLog('info', `[Admin] O e-mail de recuperação do administrador "${admin.username}" foi atualizado para "${email}".`);
    res.json({ success: true, message: 'Perfil atualizado com sucesso.' });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});

// ── Endpoint público: Configurações Pix ──────────────────────────────────────
app.get('/api/pix', async (req, res) => {
  try {
    const payload = await db.getConfig('pix_payload');
    const nome    = await db.getConfig('pix_nome');
    const chave   = await db.getConfig('pix_chave');
    res.json({
      payload: payload?.valor || '',
      nome:    nome?.valor    || 'Studio Ana Dias',
      chave:   chave?.valor   || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações Pix.' });
  }
});

// Atualizar configurações Pix (admin autenticado)
app.post('/api/pix', authenticateAdmin, async (req, res) => {
  const { payload, nome, chave } = req.body;
  if (!payload) return res.status(400).json({ error: 'O código Pix (payload) é obrigatório.' });
  try {
    await db.setConfig('pix_payload', payload.trim());
    if (nome)  await db.setConfig('pix_nome',  nome.trim());
    if (chave) await db.setConfig('pix_chave', chave.trim());
    await db.addLog('info', '[Admin] Configurações Pix atualizadas.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configurações Pix.' });
  }
});

// Obter fotos do "Sobre Mim"
app.get('/api/sobre-fotos', async (req, res) => {
  try {
    const pessoal  = await db.getConfig('sobre_foto_pessoal');
    const trabalho = await db.getConfig('sobre_foto_trabalho');
    res.json({
      fotoPessoal:  pessoal?.valor  || '/assets/ana-julia.jpg',
      fotoTrabalho: trabalho?.valor || '/assets/ana-work.jpg'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar fotos do Sobre Mim.' });
  }
});

// Atualizar fotos do "Sobre Mim" (admin autenticado)
app.post('/api/sobre-fotos', authenticateAdmin, async (req, res) => {
  const { fotoPessoal, fotoTrabalho } = req.body;
  try {
    if (fotoPessoal)  await db.setConfig('sobre_foto_pessoal',  fotoPessoal);
    if (fotoTrabalho) await db.setConfig('sobre_foto_trabalho', fotoTrabalho);
    
    await db.addLog('info', '[Admin] Fotos da seção Sobre Mim atualizadas.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar fotos.' });
  }
});

// ── Endpoint público: Slots disponíveis por semana ───────────────────────────
app.get('/api/slots', async (req, res) => {
  try {
    // 1. Carregar configurações e folgas
    const configHorarios = await db.getConfig('horarios_trabalho');
    const configDias = await db.getConfig('dias_trabalho');
    const listFolgas = await db.getFolgas();

    const horariosDisponiveis = configHorarios ? JSON.parse(configHorarios.valor) : ['09:00','10:00','11:00','12:00','14:00','15:00','16:00','17:00','18:00'];
    const diasTrabalho = configDias ? JSON.parse(configDias.valor) : [1,2,3,4,5,6]; // default Seg a Sáb

    // Criar Sets e Mapas para busca rápida de folgas
    const folgasDatas = new Set();
    const folgasDiasSemana = new Set();
    listFolgas.forEach(f => {
      if (f.tipo === 'data' && f.data) {
        folgasDatas.add(f.data);
      } else if (f.tipo === 'dia_semana' && f.dia_semana !== null) {
        folgasDiasSemana.add(Number(f.dia_semana));
      }
    });

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
      const currentDayOfWeek = dateObj.getDay();

      // Verificar se é folga recorrente ou pontual
      const isFolga = folgasDatas.has(date) || folgasDiasSemana.has(currentDayOfWeek) || !diasTrabalho.includes(currentDayOfWeek);

      const slots = horariosDisponiveis.map(hora => {
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

        const available = !isPast && !isBooked && !isPastSlot && !isFolga;
        if (available) totalAvailable++;

        return { hora, available, booked: isBooked };
      });

      return {
        date,
        label: dateObj.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        weekday: dateObj.toLocaleDateString('pt-BR', { weekday: 'long' }),
        isPast,
        isFolga,
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
      
      // Notificação para o administrador principal
      const adminWhatsApp = `19992471473`;
      const msgAdmin = `📢 *Novo Agendamento Confirmado!* \n\n👤 *Cliente:* ${nome}\n📞 *WhatsApp:* ${telefone}\n✨ *Procedimento:* ${servico_nome}\n📅 *Data:* ${data}\n⏰ *Horário:* ${hora}\n💰 *Sinal Pix:* Confirmado 20%`;
      await db.addLog('success', `[WhatsApp Notificação Admin] Alerta enviado para +${adminWhatsApp}. Conteúdo: "${msgAdmin}"`);
      
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
// ── Folgas e Feriados Endpoints ───────────────────────────────────────────
app.get('/api/folgas', async (req, res) => {
  try {
    const data = await db.getFolgas();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar folgas.' });
  }
});

app.post('/api/folgas', authenticateAdmin, async (req, res) => {
  try {
    const { tipo, data, dia_semana, descricao } = req.body;
    if (!tipo || !descricao) {
      return res.status(400).json({ error: 'Tipo e descrição são obrigatórios.' });
    }
    const novaFolga = await db.createFolga(tipo, data, dia_semana, descricao);
    await db.addLog('info', `[Admin] Nova folga cadastrada: "${descricao}" (${tipo})`);
    res.status(201).json(novaFolga);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cadastrar folga.' });
  }
});

app.delete('/api/folgas/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.deleteFolga(Number(req.params.id));
    await db.addLog('info', `[Admin] Folga ID #${req.params.id} removida.`);
    res.json({ message: 'Folga removida com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover folga.' });
  }
});

// ── Configurações Endpoints ──────────────────────────────────────────────────
app.get('/api/configuracoes', async (req, res) => {
  try {
    const data = await db.getAllConfigs();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações.' });
  }
});

app.post('/api/configuracoes', authenticateAdmin, async (req, res) => {
  try {
    const { chave, valor } = req.body;
    if (!chave || !valor) {
      return res.status(400).json({ error: 'Chave e valor são obrigatórios.' });
    }
    await db.setConfig(chave, valor);
    await db.addLog('info', `[Admin] Configuração atualizada: ${chave}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configuração.' });
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
