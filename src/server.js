const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      cpf TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      endereco TEXT NOT NULL,
      cidade TEXT NOT NULL,
      cep TEXT NOT NULL,
      status TEXT DEFAULT 'aguardando_pagamento',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

app.post('/api/checkout', async (req, res) => {
  const { nome, cpf, whatsapp, endereco, cidade, cep } = req.body;

  if (!nome || !cpf || !whatsapp || !endereco || !cidade || !cep) {
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO pedidos (nome, cpf, whatsapp, endereco, cidade, cep)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [nome, cpf, whatsapp, endereco, cidade, cep]
    );

    res.json({ sucesso: true, pedido_id: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao salvar pedido:', err.message);
    res.status(500).json({ erro: 'Erro interno.' });
  }
});

// Rota para listar pedidos (protegida por token simples)
app.get('/api/pedidos', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  const result = await pool.query('SELECT * FROM pedidos ORDER BY criado_em DESC');
  res.json(result.rows);
});

app.listen(PORT, async () => {
  console.log(`Iniciando servidor na porta ${PORT}...`);
  try {
    await initDB();
    console.log(`Servidor rodando na porta ${PORT}`);
  } catch (err) {
    console.error('Erro ao conectar no banco:', err.message);
    process.exit(1);
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});
