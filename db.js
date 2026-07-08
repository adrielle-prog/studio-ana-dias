const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'studio_ana_dias.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao abrir o banco de dados:', err.message);
  } else {
    console.log('Conectado ao banco SQLite em:', dbPath);
    initializeDatabase();
  }
});

// Habilitar chaves estrangeiras
db.run('PRAGMA foreign_keys = ON;');

// Helpers para Promises
const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
};

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

async function initializeDatabase() {
  try {
    // Tabela de clientes
    await dbRun(`
      CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        telefone TEXT UNIQUE NOT NULL,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de agendamentos
    await dbRun(`
      CREATE TABLE IF NOT EXISTS agendamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER NOT NULL,
        servico_id TEXT NOT NULL,
        servico_nome TEXT NOT NULL,
        data TEXT NOT NULL,
        hora TEXT NOT NULL,
        status_pix TEXT NOT NULL,
        origem_site TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
        UNIQUE(data, hora)
      )
    `);

    // Tabela de logs de automação
    await dbRun(`
      CREATE TABLE IF NOT EXISTS logs_automacao (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL,
        mensagem TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de administrador
    await dbRun(`
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de serviços
    await dbRun(`
      CREATE TABLE IF NOT EXISTS servicos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        preco REAL NOT NULL,
        duracao_min INTEGER NOT NULL,
        descricao TEXT,
        imagem TEXT, -- Armazenará link ou base64
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de portfólio (Antes/Depois)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT NOT NULL,
        imagem_antes TEXT NOT NULL,
        imagem_depois TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de folgas e feriados
    await dbRun(`
      CREATE TABLE IF NOT EXISTS folgas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL CHECK(tipo IN ('data','dia_semana')),
        data TEXT,          -- YYYY-MM-DD  (usado quando tipo='data')
        dia_semana INTEGER, -- 0=Dom ... 6=Sáb (usado quando tipo='dia_semana')
        descricao TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de configurações gerais (chave/valor)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      )
    `);

    console.log('Tabelas do banco de dados inicializadas.');

    // Seed admin se estiver vazio
    const adminCount = await dbGet('SELECT COUNT(*) as count FROM admin');
    if (adminCount.count === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await dbRun('INSERT INTO admin (username, password_hash) VALUES (?, ?)', ['admin', hash]);
      console.log('Seed: Administrador padrão criado (username: admin, password: admin123)');
    }

    // Seed serviços se estiver vazio
    const servicosCount = await dbGet('SELECT COUNT(*) as count FROM servicos');
    if (servicosCount.count === 0) {
      const defaultServices = [
        ['Cílios (Extensão)', 120.00, 60, 'Extensão de cílios clássica ou volume russo para destacar seu olhar.'],
        ['Sobrancelha (Design)', 50.00, 40, 'Design de sobrancelhas personalizado para harmonizar seu rosto.'],
        ['Cabelo (Corte/Escova)', 90.00, 50, 'Lavagem especial, corte moderno e escova modeladora.'],
        ['Unhas de Gel', 100.00, 90, 'Alongamento e blindagem de unhas com gel premium durável.']
      ];
      for (const s of defaultServices) {
        await dbRun('INSERT INTO servicos (nome, preco, duracao_min, descricao) VALUES (?, ?, ?, ?)', s);
      }
      console.log('Seed: Serviços padrão criados.');
    }

    // Seed configurações padrão
    const defaultConfigs = [
      ['horarios_trabalho', JSON.stringify(['09:00','10:00','11:00','12:00','14:00','15:00','16:00','17:00','18:00'])],
      ['dias_trabalho',     JSON.stringify([1,2,3,4,5,6])],  // Seg(1) a Sáb(6)
      ['pix_payload',       '00020126330014BR.GOV.BCB.PIX0111506257518415204000053039865802BR5921Ana Julia Santos Dias6009SAO PAULO62140510Q2XWiQHBFJ630404F2'],
      ['pix_nome',          'Ana Julia Santos Dias'],
      ['pix_chave',         '50625751841'],
      ['sobre_foto_pessoal', '/assets/ana-julia.jpg'],
      ['sobre_foto_trabalho', '/assets/ana-work.jpg'],
    ];
    for (const [chave, valor] of defaultConfigs) {
      await dbRun('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)', [chave, valor]);
    }

    // Seed: domingo como folga recorrente (se não existir)
    const folgaCount = await dbGet('SELECT COUNT(*) as count FROM folgas WHERE tipo = ? AND dia_semana = ?', ['dia_semana', 0]);
    if (folgaCount.count === 0) {
      await dbRun(
        'INSERT INTO folgas (tipo, dia_semana, descricao) VALUES (?, ?, ?)',
        ['dia_semana', 0, 'Domingo — fechado']
      );
      console.log('Seed: Folga de domingo criada.');
    }

    await dbHelpers.addLog('info', 'Banco de dados e seeds inicializados com sucesso.');
  } catch (error) {
    console.error('Erro ao inicializar tabelas:', error);
  }
}

// Funções Helpers
const dbHelpers = {
  addLog: async (tipo, message) => {
    try {
      await dbRun('INSERT INTO logs_automacao (tipo, mensagem) VALUES (?, ?)', [tipo, message]);
    } catch (e) {
      console.error('Erro ao salvar log:', e);
    }
  },

  getLogs: () => {
    return dbAll('SELECT * FROM logs_automacao ORDER BY timestamp DESC LIMIT 100');
  },

  clearLogs: () => {
    return dbRun('DELETE FROM logs_automacao');
  },

  // Autenticação Admin
  getAdminByUsername: (username) => {
    return dbGet('SELECT * FROM admin WHERE username = ?', [username]);
  },

  getAdminById: (id) => {
    return dbGet('SELECT * FROM admin WHERE id = ?', [id]);
  },

  updateAdminPassword: (username, newHash) => {
    return dbRun('UPDATE admin SET password_hash = ? WHERE username = ?', [newHash, username]);
  },

  updateAdminProfile: (id, email) => {
    return dbRun('UPDATE admin SET email = ? WHERE id = ?', [email, id]);
  },

  // Clientes e Agendamentos
  getOrCreateCliente: async (nome, telefone, email) => {
    const existing = await dbGet('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
    if (existing) {
      if (email && existing.email !== email) {
        await dbRun('UPDATE clientes SET email = ?, nome = ? WHERE id = ?', [email, nome, existing.id]);
        existing.email = email;
        existing.nome = nome;
      }
      return existing;
    }
    const result = await dbRun('INSERT INTO clientes (nome, telefone, email) VALUES (?, ?, ?)', [nome, telefone, email]);
    return { id: result.lastID, nome, telefone, email };
  },

  checkDoubleBooking: async (data, hora) => {
    const booking = await dbGet('SELECT * FROM agendamentos WHERE data = ? AND hora = ?', [data, hora]);
    return !!booking;
  },

  createAgendamento: async (cliente_id, servico_id, servico_nome, data, hora, status_pix, origem_site) => {
    const result = await dbRun(
      'INSERT INTO agendamentos (cliente_id, servico_id, servico_nome, data, hora, status_pix, origem_site) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cliente_id, servico_id, servico_nome, data, hora, status_pix, origem_site]
    );
    return { id: result.lastID, cliente_id, servico_id, servico_nome, data, hora, status_pix, origem_site };
  },

  getAgendamentos: () => {
    return dbAll(`
      SELECT a.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.email as cliente_email
      FROM agendamentos a
      JOIN clientes c ON a.cliente_id = c.id
      ORDER BY a.data DESC, a.hora DESC
    `);
  },

  deleteAgendamento: (id) => {
    return dbRun('DELETE FROM agendamentos WHERE id = ?', [id]);
  },

  // CRUD de Serviços
  getServicos: () => {
    return dbAll('SELECT * FROM servicos ORDER BY nome');
  },

  getServicoById: (id) => {
    return dbGet('SELECT * FROM servicos WHERE id = ?', [id]);
  },

  createServico: async (nome, preco, duracao_min, descricao, imagem) => {
    const result = await dbRun(
      'INSERT INTO servicos (nome, preco, duracao_min, descricao, imagem) VALUES (?, ?, ?, ?, ?)',
      [nome, preco, duracao_min, descricao, imagem]
    );
    return { id: result.lastID, nome, preco, duracao_min, descricao, imagem };
  },

  updateServico: (id, nome, preco, duracao_min, descricao, imagem) => {
    return dbRun(
      'UPDATE servicos SET nome = ?, preco = ?, duracao_min = ?, descricao = ?, imagem = COALESCE(?, imagem) WHERE id = ?',
      [nome, preco, duracao_min, descricao, imagem, id]
    );
  },

  deleteServico: (id) => {
    return dbRun('DELETE FROM servicos WHERE id = ?', [id]);
  },

  // CRUD de Portfólio (Antes/Depois)
  getPortfolio: () => {
    return dbAll('SELECT * FROM portfolio ORDER BY created_at DESC');
  },

  createPortfolioItem: async (titulo, imagem_antes, imagem_depois) => {
    const result = await dbRun(
      'INSERT INTO portfolio (titulo, imagem_antes, imagem_depois) VALUES (?, ?, ?)',
      [titulo, imagem_antes, imagem_depois]
    );
    return { id: result.lastID, titulo, imagem_antes, imagem_depois };
  },

  deletePortfolioItem: (id) => {
    return dbRun('DELETE FROM portfolio WHERE id = ?', [id]);
  },

  // Slots ocupados (para o calendário semanal)
  getBookedSlots: (startDate, endDate) => {
    return dbAll(
      'SELECT data, hora FROM agendamentos WHERE data >= ? AND data <= ? ORDER BY data, hora',
      [startDate, endDate]
    );
  },

  // ── Folgas & Feriados ──────────────────────────────────────────
  getFolgas: () => dbAll('SELECT * FROM folgas ORDER BY tipo, dia_semana, data'),

  createFolga: async (tipo, data, dia_semana, descricao) => {
    const result = await dbRun(
      'INSERT INTO folgas (tipo, data, dia_semana, descricao) VALUES (?, ?, ?, ?)',
      [tipo, data || null, dia_semana !== undefined ? dia_semana : null, descricao]
    );
    return { id: result.lastID, tipo, data, dia_semana, descricao };
  },

  deleteFolga: (id) => dbRun('DELETE FROM folgas WHERE id = ?', [id]),

  // ── Configurações ──────────────────────────────────────────────
  getConfig: (chave) => dbGet('SELECT valor FROM configuracoes WHERE chave = ?', [chave]),

  getAllConfigs: () => dbAll('SELECT chave, valor FROM configuracoes'),

  setConfig: async (chave, valor) => {
    await dbRun(
      'INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
      [chave, valor]
    );
  },

  // Estatísticas
  getStats: async () => {
    const totalAppointments = await dbGet('SELECT COUNT(*) as count FROM agendamentos');
    const totalClients = await dbGet('SELECT COUNT(*) as count FROM clientes');
    const totalServices = await dbGet('SELECT COUNT(*) as count FROM servicos');
    
    // Obter faturamento (calculado baseado em 20% do sinal dos agendamentos confirmados)
    // Para simplificar, o sinal de 20% é calculado sobre a média de preço dos serviços ou o preço específico.
    // Vamos somar os valores dos serviços agendados e aplicar 20%.
    const faturamentoRow = await dbGet(`
      SELECT SUM(s.preco) as total_bruto
      FROM agendamentos a
      JOIN servicos s ON a.servico_id = s.id OR a.servico_nome = s.nome
      WHERE a.status_pix = 'pago'
    `);
    const faturamentoBruto = faturamentoRow?.total_bruto || 0;
    const faturamentoSinal = faturamentoBruto * 0.20;

    return {
      totalAppointments: totalAppointments?.count || 0,
      totalClients: totalClients?.count || 0,
      totalServices: totalServices?.count || 0,
      revenueSinal: parseFloat(faturamentoSinal.toFixed(2)),
      revenueTotal: parseFloat(faturamentoBruto.toFixed(2))
    };
  }
};

module.exports = dbHelpers;
