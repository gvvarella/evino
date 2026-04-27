const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

const PAYMENTSBLACK_API = 'https://api.paymentsblack.com';
const API_KEY = process.env.PAYMENTSBLACK_API_KEY;
const API_SECRET = process.env.PAYMENTSBLACK_API_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

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
      bairro TEXT DEFAULT '',
      cidade TEXT NOT NULL,
      estado TEXT DEFAULT '',
      cep TEXT NOT NULL,
      transaction_id TEXT,
      status TEXT DEFAULT 'aguardando_pagamento',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function criarPix(pedido) {
  const payload = {
    amount: 12.99,
    description: 'Kit Premium Bolsa + 6 Tacas',
    customer: {
      name: pedido.nome,
      email: `${pedido.cpf.replace(/\D/g, '')}@brindevipevino.com.br`,
      phone: pedido.whatsapp.replace(/\D/g, ''),
      document: {
        number: pedido.cpf.replace(/\D/g, ''),
        type: 'cpf',
      },
    },
    items: [{ title: 'Kit Premium Bolsa + 6 Tacas Acrilicas', unitPrice: 1299, quantity: 1 }],
    postbackUrl: WEBHOOK_URL,
  };

  const response = await fetch(`${PAYMENTSBLACK_API}/api/v1/pix/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-API-Secret': API_SECRET,
    },
    body: JSON.stringify(payload),
  });

  return response.json();
}

// Checkout — cria PIX e salva pedido
app.post('/api/checkout', async (req, res) => {
  const { nome, cpf, whatsapp, endereco, bairro, cidade, estado, cep } = req.body;

  if (!nome || !cpf || !whatsapp || !endereco || !cidade || !cep) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatorios.' });
  }

  try {
    const pixResp = await criarPix({ nome, cpf, whatsapp });

    if (pixResp.status !== 'true') {
      console.error('Erro PIX:', JSON.stringify(pixResp));
      throw new Error('Falha ao gerar PIX');
    }

    const { transactionId, copiaecola, qrcode, amount } = pixResp.paymentData;

    const result = await pool.query(
      `INSERT INTO pedidos (nome, cpf, whatsapp, endereco, bairro, cidade, estado, cep, transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [nome, cpf, whatsapp, endereco, bairro || '', cidade, estado || '', cep, transactionId]
    );

    res.json({ sucesso: true, pedido_id: result.rows[0].id, transaction_id: transactionId, qrcode, copiaecola, amount });
  } catch (err) {
    console.error('Erro checkout:', err.message);
    res.status(500).json({ erro: 'Erro ao processar pedido. Tente novamente.' });
  }
});

// Polling — consulta status do pagamento
app.get('/api/checkout/:transactionId/status', async (req, res) => {
  const { transactionId } = req.params;

  try {
    const response = await fetch(`${PAYMENTSBLACK_API}/api/v1/transactions/${transactionId}/status`, {
      headers: { 'X-API-Key': API_KEY, 'X-API-Secret': API_SECRET },
    });
    const data = await response.json();
    const status = data.data?.status || 'PENDING';

    if (status === 'COMPLETED') {
      await pool.query('UPDATE pedidos SET status=$1 WHERE transaction_id=$2', ['pago', transactionId]);
    }

    res.json({ status });
  } catch {
    res.json({ status: 'PENDING' });
  }
});

// Webhook — recebe confirmação da PaymentsBlack
app.post('/api/webhook/pix', async (req, res) => {
  const { transaction_id, status } = req.body;
  console.log('Webhook recebido:', transaction_id, status);

  try {
    if (transaction_id && status) {
      await pool.query('UPDATE pedidos SET status=$1 WHERE transaction_id=$2', [status.toLowerCase(), transaction_id]);
    }
  } catch (err) {
    console.error('Webhook erro:', err.message);
  }

  res.status(200).json({ received: true });
});

// CEP — proxy ViaCEP
app.get('/api/cep/:cep', async (req, res) => {
  const cep = req.params.cep.replace(/\D/g, '');

  if (cep.length !== 8) return res.status(400).json({ erro: 'CEP invalido' });

  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const data = await response.json();

    if (data.erro) return res.status(404).json({ erro: 'CEP nao encontrado' });

    res.json({ logradouro: data.logradouro, bairro: data.bairro, cidade: data.localidade, estado: data.uf });
  } catch {
    res.status(500).json({ erro: 'Erro ao buscar CEP' });
  }
});

// Admin — listar pedidos
app.get('/api/pedidos', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ erro: 'Nao autorizado.' });
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
