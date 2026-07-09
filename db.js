const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');

const isPostgres = !!process.env.DATABASE_URL;
let pgPool = null;
let sqliteDb = null;

if (isPostgres) {
  console.log('Detectado banco PostgreSQL no ambiente. Conectando...');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Necessário para a nuvem (Render/Neon)
  });
  initializeDatabase();
} else {
  const dbPath = path.join(__dirname, 'studio_ana_dias.db');
  console.log('Sem DATABASE_URL. Conectando ao SQLite local em:', dbPath);
  sqliteDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Erro ao abrir banco SQLite:', err.message);
    } else {
      sqliteDb.run('PRAGMA foreign_keys = ON;');
      initializeDatabase();
    }
  });
}

// Helper para converter query de ? para $1, $2 etc no Postgres
function translateQuery(sql, params = []) {
  if (!isPostgres) {
    // Compatibilidade de INSERT OR IGNORE no SQLite
    return { sql, params };
  }
  
  // Converter placeholders ? para $1, $2
  let pgSql = sql;
  let index = 1;
  while (pgSql.includes('?')) {
    pgSql = pgSql.replace('?', `$${index++}`);
  }

  // Converter comandos específicos
  pgSql = pgSql.replace(/INSERT OR IGNORE INTO configuracoes/gi, 'INSERT INTO configuracoes');
  if (sql.toLowerCase().includes('insert or ignore into configuracoes')) {
    pgSql += ' ON CONFLICT (chave) DO NOTHING';
  }

  return { sql: pgSql, params };
}

// Helpers para Promises
const dbGet = (sql, params = []) => {
  const q = translateQuery(sql, params);
  if (isPostgres) {
    return pgPool.query(q.sql, q.params).then(res => res.rows[0] || null);
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.get(q.sql, q.params, (err, row) => err ? reject(err) : resolve(row));
    });
  }
};

const dbAll = (sql, params = []) => {
  const q = translateQuery(sql, params);
  if (isPostgres) {
    return pgPool.query(q.sql, q.params).then(res => res.rows);
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.all(q.sql, q.params, (err, rows) => err ? reject(err) : resolve(rows));
    });
  }
};

const dbRun = (sql, params = []) => {
  const q = translateQuery(sql, params);
  if (isPostgres) {
    return pgPool.query(q.sql, q.params).then(res => ({ id: res.insertId, lastID: res.insertId, changes: res.rowCount }));
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.run(q.sql, q.params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, lastID: this.lastID, changes: this.changes });
      });
    });
  }
};

async function initializeDatabase() {
  try {
    const serialType = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const textType = isPostgres ? 'TEXT' : 'TEXT';

    // Tabela de clientes
    await dbRun(`
      CREATE TABLE IF NOT EXISTS clientes (
        id ${serialType},
        nome TEXT NOT NULL,
        telefone TEXT UNIQUE NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de agendamentos
    await dbRun(`
      CREATE TABLE IF NOT EXISTS agendamentos (
        id ${serialType},
        cliente_id INTEGER NOT NULL,
        servico_id TEXT NOT NULL,
        servico_nome TEXT NOT NULL,
        data TEXT NOT NULL,
        hora TEXT NOT NULL,
        status_pix TEXT NOT NULL,
        origem_site TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(data, hora)
      )
    `);

    // Tabela de logs de automação
    await dbRun(`
      CREATE TABLE IF NOT EXISTS logs_automacao (
        id ${serialType},
        tipo TEXT NOT NULL,
        mensagem TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de administrador
    await dbRun(`
      CREATE TABLE IF NOT EXISTS admin (
        id ${serialType},
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de serviços
    await dbRun(`
      CREATE TABLE IF NOT EXISTS servicos (
        id ${serialType},
        nome TEXT NOT NULL,
        preco REAL NOT NULL,
        duracao_min INTEGER NOT NULL,
        descricao TEXT,
        imagem TEXT, 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de portfólio (Antes/Depois)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id ${serialType},
        titulo TEXT NOT NULL,
        imagem_antes TEXT NOT NULL,
        imagem_depois TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de folgas e feriados
    await dbRun(`
      CREATE TABLE IF NOT EXISTS folgas (
        id ${serialType},
        tipo TEXT NOT NULL,
        data TEXT,          
        dia_semana INTEGER, 
        descricao TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de configurações gerais (chave/valor)
    if (isPostgres) {
      await dbRun(`
        CREATE TABLE IF NOT EXISTS configuracoes (
          chave TEXT PRIMARY KEY,
          valor TEXT NOT NULL
        )
      `);
    } else {
      await dbRun(`
        CREATE TABLE IF NOT EXISTS configuracoes (
          chave TEXT PRIMARY KEY,
          valor TEXT NOT NULL
        )
      `);
    }

    // Tabela de depoimentos de clientes
    await dbRun(`
      CREATE TABLE IF NOT EXISTS depoimentos (
        id ${serialType},
        nome TEXT NOT NULL,
        servico TEXT,
        texto TEXT NOT NULL,
        foto TEXT,
        rating INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pendente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Tabelas do banco de dados inicializadas.');

    // Seed admin — usa hash persistido no env var do Render se disponível
    const adminCount = await dbGet('SELECT COUNT(*) as count FROM admin');
    if (adminCount.count === 0 || adminCount.count === '0') {
      const hash = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 10);
      const username = process.env.ADMIN_USERNAME || 'admin';
      await dbRun('INSERT INTO admin (username, password_hash) VALUES (?, ?)', [username, hash]);
      const source = process.env.ADMIN_PASSWORD_HASH ? 'variável de ambiente' : 'padrão (admin123)';
      console.log(`Seed: Administrador criado a partir da ${source}. Username: ${username}`);
    } else if (process.env.ADMIN_PASSWORD_HASH) {
      await dbRun('UPDATE admin SET password_hash = ? WHERE id = 1', [process.env.ADMIN_PASSWORD_HASH]);
    }

    // Seed serviços se estiver vazio
    const servicosCount = await dbGet('SELECT COUNT(*) as count FROM servicos');
    if (servicosCount.count === 0 || servicosCount.count === '0') {
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
      ['dias_trabalho',     JSON.stringify([1,2,3,4,5,6])],  
      ['pix_payload',       '00020126330014BR.GOV.BCB.PIX0111506257518415204000053039865802BR5921Ana Julia Santos Dias6009SAO PAULO62140510Q2XWiQHBFJ630404F2'],
      ['pix_nome',          'Ana Julia Santos Dias'],
      ['pix_chave',         '50625751841'],
      ['sobre_foto_pessoal', '/assets/ana-julia.jpg'],
      ['sobre_foto_trabalho', '/assets/ana-work.jpg'],
    ];
    for (const [chave, valor] of defaultConfigs) {
      await dbRun('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)', [chave, valor]);
    }

    // Seed: domingo como folga recorrente
    const folgaCount = await dbGet('SELECT COUNT(*) as count FROM folgas WHERE tipo = ? AND dia_semana = ?', ['dia_semana', 0]);
    if (folgaCount.count === 0 || folgaCount.count === '0') {
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

  getOrCreateCliente: async (nome, telefone, email) => {
    const existing = await dbGet('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
    if (existing) {
      if (email && existing.email !== email) {
        await dbRun('UPDATE clientes SET email = ?, nome = ? WHERE id = ?', [email, nome, existing.id]);
      }
      return existing;
    }
    const result = await dbRun('INSERT INTO clientes (nome, telefone, email) VALUES (?, ?, ?)', [nome, telefone, email || null]);
    const insertId = result.lastID;
    return { id: insertId, nome, telefone, email };
  },

  createAgendamento: async (clienteId, servicoId, servicoNome, data, hora, statusPix, origemSite) => {
    const result = await dbRun(
      'INSERT INTO agendamentos (cliente_id, servico_id, servico_nome, data, hora, status_pix, origem_site) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [clienteId, servicoId, servicoNome, data, hora, statusPix, origemSite]
    );
    return { id: result.lastID, clienteId, servicoId, servicoNome, data, hora, statusPix, origemSite };
  },

  checkDoubleBooking: async (data, hora) => {
    const row = await dbGet('SELECT COUNT(*) as count FROM agendamentos WHERE data = ? AND hora = ?', [data, hora]);
    return (row?.count || 0) > 0 || row?.count === '1';
  },

  getAgendamentosSemana: (dataInicio, dataFim) => {
    return dbAll(
      `SELECT a.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.email as cliente_email 
       FROM agendamentos a
       JOIN clientes c ON a.cliente_id = c.id
       WHERE a.data >= ? AND a.data <= ?
       ORDER BY a.data ASC, a.hora ASC`,
      [dataInicio, dataFim]
    );
  },

  getAllAgendamentos: () => {
    return dbAll(
      `SELECT a.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.email as cliente_email 
       FROM agendamentos a
       JOIN clientes c ON a.cliente_id = c.id
       ORDER BY a.data DESC, a.hora DESC`
    );
  },

  deleteAgendamento: (id) => {
    return dbRun('DELETE FROM agendamentos WHERE id = ?', [id]);
  },

  // Serviços CRUD
  getServicos: () => {
    return dbAll('SELECT * FROM servicos ORDER BY id ASC');
  },

  getServicoById: (id) => {
    return dbGet('SELECT * FROM servicos WHERE id = ?', [id]);
  },

  createServico: (nome, preco, duracaoMin, descricao, imagem) => {
    return dbRun(
      'INSERT INTO servicos (nome, preco, duracao_min, descricao, imagem) VALUES (?, ?, ?, ?, ?)',
      [nome, preco, duracaoMin, descricao || null, imagem || null]
    );
  },

  updateServico: (id, nome, preco, duracaoMin, descricao, imagem) => {
    return dbRun(
      'UPDATE servicos SET nome = ?, preco = ?, duracao_min = ?, descricao = ?, imagem = ? WHERE id = ?',
      [nome, preco, duracaoMin, descricao || null, imagem || null, id]
    );
  },

  deleteServico: (id) => {
    return dbRun('DELETE FROM servicos WHERE id = ?', [id]);
  },

  // Portfólio CRUD
  getPortfolio: () => {
    return dbAll('SELECT * FROM portfolio ORDER BY id DESC');
  },

  createPortfolioItem: (titulo, imagemAntes, imagemDepois) => {
    return dbRun(
      'INSERT INTO portfolio (titulo, imagem_antes, imagem_depois) VALUES (?, ?, ?)',
      [titulo, imagemAntes, imagemDepois]
    );
  },

  deletePortfolioItem: (id) => {
    return dbRun('DELETE FROM portfolio WHERE id = ?', [id]);
  },

  // Folgas e Agenda Config
  getFolgas: () => {
    return dbAll('SELECT * FROM folgas ORDER BY created_at DESC');
  },

  createFolga: (tipo, data, diaSemana, descricao) => {
    return dbRun(
      'INSERT INTO folgas (tipo, data, dia_semana, descricao) VALUES (?, ?, ?, ?)',
      [tipo, data || null, diaSemana !== null ? Number(diaSemana) : null, descricao]
    );
  },

  deleteFolga: (id) => {
    return dbRun('DELETE FROM folgas WHERE id = ?', [id]);
  },

  getConfig: async (chave) => {
    const row = await dbGet('SELECT valor FROM configuracoes WHERE chave = ?', [chave]);
    return row ? row.valor : null;
  },

  setConfig: async (chave, valor) => {
    const existing = await dbGet('SELECT valor FROM configuracoes WHERE chave = ?', [chave]);
    if (existing !== null) {
      return dbRun('UPDATE configuracoes SET valor = ? WHERE chave = ?', [valor, chave]);
    }
    return dbRun('INSERT INTO configuracoes (chave, valor) VALUES (?, ?)', [chave, valor]);
  },

  getStats: async () => {
    const totalAppointments = await dbGet('SELECT COUNT(*) as count FROM agendamentos');
    const totalClients = await dbGet('SELECT COUNT(*) as count FROM clientes');
    const totalServices = await dbGet('SELECT COUNT(*) as count FROM servicos');
    
    const faturamentoRow = await dbGet(`
      SELECT SUM(s.preco) as total_bruto
      FROM agendamentos a
      JOIN servicos s ON a.servico_id = CAST(s.id AS TEXT) OR a.servico_nome = s.nome
      WHERE a.status_pix = 'pago'
    `);
    const faturamentoBruto = faturamentoRow?.total_bruto || 0;
    const faturamentoSinal = faturamentoBruto * 0.20;

    return {
      totalAppointments: Number(totalAppointments?.count) || 0,
      totalClients: Number(totalClients?.count) || 0,
      totalServices: Number(totalServices?.count) || 0,
      revenueSinal: parseFloat(faturamentoSinal.toFixed(2)),
      revenueTotal: parseFloat(faturamentoBruto.toFixed(2))
    };
  },

  createDepoimento: (nome, servico, texto, foto, rating) => {
    return dbRun(
      `INSERT INTO depoimentos (nome, servico, texto, foto, rating, status) VALUES (?, ?, ?, ?, ?, 'pendente')`,
      [nome, servico || null, texto, foto || null, rating || 5]
    );
  },

  getDepoimentosAprovados: () => {
    return dbAll(`SELECT * FROM depoimentos WHERE status = 'aprovado' ORDER BY created_at DESC`);
  },

  getAllDepoimentos: () => {
    return dbAll(`SELECT * FROM depoimentos ORDER BY status ASC, created_at DESC`);
  },

  updateDepoimentoStatus: (id, status) => {
    return dbRun(`UPDATE depoimentos SET status = ? WHERE id = ?`, [status, id]);
  },

  deleteDepoimento: (id) => {
    return dbRun(`DELETE FROM depoimentos WHERE id = ?`, [id]);
  }
};

module.exports = dbHelpers;
