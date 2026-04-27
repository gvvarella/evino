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
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_ADMIN = process.env.EMAIL_ADMIN;
const EMAIL_FROM = process.env.EMAIL_FROM || 'pedidos@brindevipevino.com.br';

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
      transaction_id TEXT,
      status TEXT DEFAULT 'aguardando_pagamento',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migracoes — adiciona colunas novas se nao existirem
  await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS bairro TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
}

async function enviarEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
  } catch (err) {
    console.error('Erro ao enviar email:', err.message);
  }
}

async function notificarPagamento(pedido) {
  // Email para o cliente
  await enviarEmail({
    to: pedido.email || EMAIL_ADMIN,
    subject: '✅ Pedido confirmado - Kit Premium Bolsa + 6 Taças',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#8B0000;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:24px;">✅ Pagamento Confirmado!</h1>
        </div>
        <div style="background:#f9f9f9;padding:30px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <p style="font-size:16px;color:#333;">Olá, <strong>${pedido.nome}</strong>!</p>
          <p style="color:#555;">Seu pagamento foi confirmado com sucesso. Seu pedido está sendo preparado.</p>
          <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:20px;margin:20px 0;">
            <h3 style="color:#8B0000;margin:0 0 15px;">📦 Resumo do Pedido</h3>
            <table style="width:100%;font-size:14px;color:#555;">
              <tr><td><strong>Produto:</strong></td><td>Kit Premium Bolsa + 6 Taças Acrílicas</td></tr>
              <tr><td><strong>Valor:</strong></td><td style="color:#8B0000;font-weight:bold;">R$ 12,99</td></tr>
              <tr><td><strong>Entrega:</strong></td><td>${pedido.endereco}, ${pedido.numero} - ${pedido.bairro}, ${pedido.cidade}/${pedido.estado} - CEP: ${pedido.cep}</td></tr>
              <tr><td><strong>WhatsApp:</strong></td><td>${pedido.whatsapp}</td></tr>
            </table>
          </div>
          <p style="color:#555;font-size:14px;">Em breve entraremos em contato pelo WhatsApp <strong>${pedido.whatsapp}</strong> com o código de rastreio.</p>
          <p style="color:#999;font-size:12px;margin-top:30px;">Dúvidas? Responda este e-mail ou entre em contato pelo WhatsApp.</p>
        </div>
      </div>
    `,
  });

  // Email de notificação para o admin
  await enviarEmail({
    to: EMAIL_ADMIN,
    subject: `🛒 Nova venda! ${pedido.nome} - R$ 12,99`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#1a1a1a;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:22px;">🛒 Nova Venda Confirmada!</h1>
        </div>
        <div style="background:#f9f9f9;padding:30px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <table style="width:100%;font-size:14px;color:#555;border-collapse:collapse;">
            <tr style="background:#eee;"><td colspan="2" style="padding:8px;font-weight:bold;">Dados do Cliente</td></tr>
            <tr><td style="padding:6px;"><strong>Nome:</strong></td><td>${pedido.nome}</td></tr>
            <tr><td style="padding:6px;"><strong>CPF:</strong></td><td>${pedido.cpf}</td></tr>
            <tr><td style="padding:6px;"><strong>WhatsApp:</strong></td><td>${pedido.whatsapp}</td></tr>
            <tr><td style="padding:6px;"><strong>Endereço:</strong></td><td>${pedido.endereco}, ${pedido.numero} - ${pedido.bairro}</td></tr>
            <tr><td style="padding:6px;"><strong>Cidade/UF:</strong></td><td>${pedido.cidade}/${pedido.estado}</td></tr>
            <tr><td style="padding:6px;"><strong>CEP:</strong></td><td>${pedido.cep}</td></tr>
            <tr style="background:#e8f5e9;"><td style="padding:8px;"><strong>Valor:</strong></td><td style="color:#2e7d32;font-weight:bold;">R$ 12,99</td></tr>
            <tr><td style="padding:6px;"><strong>Transaction ID:</strong></td><td style="font-size:12px;">${pedido.transaction_id}</td></tr>
          </table>
        </div>
      </div>
    `,
  });
}

async function criarPix(pedido) {
  const payload = {
    amount: 12.99,
    description: 'Kit Premium Bolsa + 6 Tacas',
    customer: {
      name: pedido.nome,
      email: pedido.email,
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
  const { nome, cpf, email, whatsapp, endereco, numero, bairro, cidade, estado, cep } = req.body;

  if (!nome || !cpf || !email || !whatsapp || !endereco || !numero || !cidade || !cep) {
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
      `INSERT INTO pedidos (nome, cpf, email, whatsapp, endereco, numero, bairro, cidade, estado, cep, transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [nome, cpf, email, whatsapp, endereco, numero, bairro || '', cidade, estado || '', cep, transactionId]
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
      const upd = await pool.query(
        'UPDATE pedidos SET status=$1 WHERE transaction_id=$2 AND status != $1 RETURNING *',
        ['pago', transactionId]
      );
      if (upd.rows.length > 0) await notificarPagamento(upd.rows[0]);
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
      const upd = await pool.query(
        'UPDATE pedidos SET status=$1 WHERE transaction_id=$2 AND status != $1 RETURNING *',
        [status.toLowerCase(), transaction_id]
      );
      if (status === 'COMPLETED' && upd.rows.length > 0) {
        await notificarPagamento(upd.rows[0]);
      }
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

// Dados do cliente — busca nome via CPF
app.get('/api/cliente/:cpf', async (req, res) => {
  const cpf = req.params.cpf.replace(/\D/g, '');

  if (cpf.length !== 11) return res.status(400).json({ erro: 'CPF invalido' });

  try {
    const response = await fetch(
      `https://api.snoopintelligence.cloud/api/v2/generic/cpf?cpf=${cpf}&token=${process.env.SNOOP_TOKEN}`
    );
    const data = await response.json();

    if (data.statusCode !== 200 || !data.body?.name) {
      return res.status(404).json({ erro: 'CPF nao encontrado' });
    }

    res.json({ nome: data.body.name });
  } catch {
    res.status(500).json({ erro: 'Erro ao buscar CPF' });
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
