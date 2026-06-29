const sqlite3 = require('sqlite3').verbose();
const path = require('path');

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

    console.log('Tabelas do banco de dados inicializadas com sucesso.');
    await dbHelpers.addLog('info', 'Banco de dados inicializado com sucesso.');
  } catch (error) {
    console.error('Erro ao inicializar tabelas:', error);
  }
}

// Funções Helpers
const dbHelpers = {
  addLog: async (tipo, mensagem) => {
    try {
      await dbRun('INSERT INTO logs_automacao (tipo, mensagem) VALUES (?, ?)', [tipo, mensagem]);
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

  getOrCreateCliente: async (nome, telefone, email) => {
    const existing = await dbGet('SELECT * FROM clientes WHERE telefone = ?', [telefone]);
    if (existing) {
      // Atualiza o email caso tenha mudado
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

  getStats: async () => {
    const totalAppointments = await dbGet('SELECT COUNT(*) as count FROM agendamentos');
    const totalClients = await dbGet('SELECT COUNT(*) as count FROM clientes');
    const successfulPix = await dbGet('SELECT COUNT(*) as count FROM agendamentos WHERE status_pix = "pago"');
    
    return {
      totalAppointments: totalAppointments?.count || 0,
      totalClients: totalClients?.count || 0,
      successfulPix: successfulPix?.count || 0,
    };
  }
};

module.exports = dbHelpers;
