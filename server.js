const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let browser;
let page;

// =========================================
// FILA DE REQUISIÇÕES
// O Puppeteer opera numa única aba do navegador — só pode processar um
// prompt por vez. Toda requisição entra na fila e espera a sua vez.
// =========================================
const requestQueue = [];
let isProcessing = false;

function processNextInQueue() {
    isProcessing = false;
    if (requestQueue.length > 0) {
        isProcessing = true;
        const next = requestQueue.shift();
        next();
    }
}

// =========================================
// AUTENTICAÇÃO POR TOKEN
// Protege os endpoints de API. O frontend local (index.html) continua
// acessível sem token. A variável de ambiente API_TOKEN define o segredo;
// se não estiver definida, os endpoints ficam abertos (modo desenvolvimento).
// =========================================
function autenticarToken(req, res, next) {
    const API_TOKEN = process.env.API_TOKEN;
    if (!API_TOKEN) return next(); // sem token configurado = acesso livre

    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== API_TOKEN) {
        return res.status(401).json({ error: 'Token inválido ou ausente.' });
    }
    next();
}

// =========================================
// INICIALIZAÇÃO DO NAVEGADOR
// =========================================
async function initBrowser() {
    console.log('Iniciando Puppeteer Stealth para Meta AI...');
    browser = await puppeteer.launch({
        headless: "new", // Alterado para "new" (true) para rodar no Docker do Easypanel sem crashar
        userDataDir: path.join(__dirname, 'user_data'), // Salva a sessão
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Injetar cookies via Variável de Ambiente (Recomendado no Easypanel) ou Arquivo
    try {
        let cookies = null;

        if (process.env.META_COOKIES) {
            console.log('Lendo cookies da variável de ambiente META_COOKIES...');
            cookies = JSON.parse(process.env.META_COOKIES);
        } else {
            const cookiePath = path.join(__dirname, 'login_automatico', 'meta.ai.cookies.json');
            if (fs.existsSync(cookiePath)) {
                console.log('Lendo cookies do arquivo json...');
                cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
            }
        }

        if (cookies) {
            await page.setCookie(...cookies);
            console.log('Cookies injetados com sucesso!');
        }
    } catch (e) {
        console.log('Aviso: Erro ao ler cookies (ignorando):', e.message);
    }

    console.log('Acessando meta.ai...');
    await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Navegador pronto! Caso peça login, por favor logue na janela aberta.');
}

// =========================================
// NÚCLEO: ENVIAR PROMPT AO META AI E OBTER RESPOSTA
// Toda a interação com o Puppeteer está concentrada aqui. Os endpoints
// (o antigo /api/chat e o novo /v1/chat/completions) chamam esta função.
// =========================================
async function enviarPromptMetaAi(prompt, newChat, clientId) {
    if (!page) throw new Error('Navegador não inicializado.');

    const logPrefix = clientId ? `[Cliente: ${clientId}]` : '[API]';
    console.log(`${logPrefix} Processando nova requisição...`);

    // Se for solicitado (ou se houver clientes diferentes), clica em "Nova Conversa" para limpar a tela
    if (newChat !== false) {
        console.log(`${logPrefix} Limpando o contexto (Nova Conversa)...`);
        await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('div, span, button'));
            const newChatBtn = elements.find(el => el.innerText && el.innerText.includes('Nova conversa'));
            if (newChatBtn) newChatBtn.click();
        });
        await new Promise(r => setTimeout(r, 1000));
    }

    // 1. Procurar a caixa de texto e focar
    console.log(`${logPrefix} Enviando prompt...`);

    const inputFound = await page.evaluate(() => {
        const input = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
        if (input) {
            input.focus();
            return true;
        }
        return false;
    });

    if (!inputFound) {
        throw new Error("Não foi possível encontrar a caixa de texto da Meta AI.");
    }

    // Clica na caixa para garantir que o React registre o foco
    await page.mouse.click(500, 700);
    await page.evaluate(() => {
        const input = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
        if (input) input.click();
    });

    // 2. Digitar usando o teclado do puppeteer mais lentamente
    await page.keyboard.type(prompt, { delay: 40 });

    // Espera o React processar o texto digitado
    await new Promise(r => setTimeout(r, 1000));

    // Enviar (pressionar Enter)
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 1000));

    // Tentar clicar no botão de enviar (caso o Enter tenha falhado na Meta AI)
    await page.evaluate(() => {
        const input = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
        if (input) {
            let parent = input.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!parent) break;
                const buttons = Array.from(parent.querySelectorAll('div[role="button"], button'));
                let sendBtn = buttons.find(b => {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    return label.includes('send') || label.includes('enviar');
                });

                if (!sendBtn) {
                    const svgBtns = buttons.filter(b => b.querySelector('svg'));
                    if (svgBtns.length > 0) {
                        sendBtn = svgBtns[svgBtns.length - 1];
                    }
                }

                if (sendBtn) {
                    sendBtn.click();
                    break;
                }
                parent = parent.parentElement;
            }
        }
    });

    await new Promise(r => setTimeout(r, 1500));

    // 3. Esperar a resposta ser gerada
    console.log(`${logPrefix} Aguardando resposta da Meta AI...`);

    let lastTextLength = 0;
    let unchangedCount = 0;
    let hasStartedAnswering = false;

    // Espera no máximo 120 segundos (60 * 2s)
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));

        const currentResponse = await page.evaluate(() => document.body.innerText);
        const isThinking = currentResponse.includes('Thinking\n') || currentResponse.includes('Pensando\n') || currentResponse.includes('Thinking...\n');

        if (currentResponse.length > lastTextLength) {
            if (lastTextLength > 0 && !isThinking) hasStartedAnswering = true;
            lastTextLength = currentResponse.length;
            unchangedCount = 0; // Reset, está gerando texto
        } else if (currentResponse.length === lastTextLength && currentResponse.length > 0) {
            unchangedCount++;
        }

        // Se o robô estiver "Pensando", damos mais tolerância (não quebramos o loop cedo)
        if (isThinking) {
            unchangedCount = 0; // Impede que o timeout de ociosidade dispare enquanto "pensa"
        }

        // Se já começou a responder (e não está mais pensando) e não mudou por 8s (4 ciclos), quebra.
        if (hasStartedAnswering && !isThinking && unchangedCount >= 4) {
            break;
        }

        // Se NÃO começou a responder ainda, espera até 40s (20 ciclos) antes de desistir.
        if (!hasStartedAnswering && unchangedCount >= 20) {
            console.log(`${logPrefix} Timeout: A resposta não começou a ser gerada.`);
            break;
        }
    }

    // 4. Extração fina da resposta
    const finalResponse = await page.evaluate((userPrompt) => {
        const rawText = document.body.innerText;

        // Tenta achar a última ocorrência da mensagem do usuário na tela
        const promptLines = userPrompt.trim().split('\n');
        const firstLineOfPrompt = promptLines[0].trim();
        const lastIndex = rawText.lastIndexOf(firstLineOfPrompt);

        if (lastIndex !== -1) {
            // Pega todo o texto que vem DEPOIS da mensagem do usuário
            let afterPrompt = rawText.substring(lastIndex + userPrompt.length);

            // Limpeza agressiva do lixo de UI do Meta AI que fica no final da tela
            const cutoffs = [
                'Ask Meta AI...',
                'Pergunte à Meta AI...',
                'Message Meta AI...',
                'Thinking\n',
                'Pensando\n',
                'Command Palette',
                'Search for a command'
            ];

            for (const cutoff of cutoffs) {
                const cutIndex = afterPrompt.indexOf(cutoff);
                if (cutIndex !== -1) {
                    afterPrompt = afterPrompt.substring(0, cutIndex);
                }
            }

            const lines = afterPrompt.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            // Pula linhas iniciais muito curtas que costumam ser a interface ("Meta AI", horários, botões)
            let startIndex = 0;
            while (startIndex < lines.length && lines[startIndex].length < 25) {
                startIndex++;
            }

            const finalStr = lines.slice(startIndex).join('\n\n');

            // Retorna o bloco final
            if (finalStr.length > 10) return finalStr;
            if (afterPrompt.trim().length > 10) return afterPrompt.trim();
        }

        // Fallback se não conseguir quebrar pelo prompt
        const allTextNodes = Array.from(document.querySelectorAll('p, span[dir="auto"], div[dir="auto"]'));
        const texts = allTextNodes.map(n => n.innerText.trim()).filter(t => t.length > 30);

        if (texts.length > 0) {
            // Tenta não retornar o próprio prompt do usuário
            for (let i = texts.length - 1; i >= 0; i--) {
                if (!texts[i].includes(firstLineOfPrompt)) {
                    return texts[i];
                }
            }
            return texts[texts.length - 1];
        }

        // Último recurso: últimos 600 caracteres da tela
        return rawText.length > 600 ? rawText.substring(rawText.length - 600) : rawText;
    }, prompt);

    console.log(`${logPrefix} Resposta obtida (${finalResponse.length} caracteres).`);
    return finalResponse;
}

// =========================================
// CONVERSÃO DE MENSAGENS OPENAI → PROMPT ÚNICO
// O Meta AI recebe texto corrido. Esta função pega o array de mensagens
// no formato OpenAI Chat Completions e monta um prompt unificado.
// =========================================
function mensagensParaPrompt(messages) {
    if (!messages || messages.length === 0) return '';

    const partes = [];
    for (const msg of messages) {
        const role = msg.role || '';
        const content = msg.content || '';
        if (!content) continue;

        if (role === 'system') {
            partes.push('Contexto e Regras do Atendimento:\n' + content);
        } else if (role === 'user') {
            partes.push('Cliente: ' + content);
        } else if (role === 'assistant') {
            partes.push('Você (Assistente): ' + content);
        } else if (role === 'tool') {
            // Resultado de uma chamada de ferramenta — inclui como contexto
            partes.push('Informação Adicional do Sistema:\n' + content);
        }
    }

    return partes.join('\n\n');
}

// =========================================
// ENDPOINT OPENAI-COMPATÍVEL: POST /v1/chat/completions
//
// Aceita o mesmo formato que OpenRouter, Groq e NVIDIA. O ChatSET chama
// este endpoint exatamente como chama qualquer outro provedor — sem
// nenhum tratamento especial no webhook.php.
// =========================================
app.post('/v1/chat/completions', autenticarToken, (req, res) => {
    const { messages, model } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: { message: 'O campo messages é obrigatório e deve ser um array não vazio.', type: 'invalid_request_error' }
        });
    }

    // Monta o prompt único a partir das mensagens
    const prompt = mensagensParaPrompt(messages);
    if (!prompt) {
        return res.status(400).json({
            error: { message: 'Nenhuma mensagem com conteúdo foi encontrada.', type: 'invalid_request_error' }
        });
    }

    const clientId = `openai-compat`;

    // Coloca na fila — o Puppeteer só processa um por vez
    const executeChat = async () => {
        try {
            const reply = await enviarPromptMetaAi(prompt, true, clientId);

            // Resposta no formato OpenAI Chat Completions
            res.json({
                id: 'chatcmpl-metaai-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model || 'meta-ai',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: reply || ''
                    },
                    finish_reason: reply ? 'stop' : 'length'
                }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            });
        } catch (error) {
            console.error('Erro no /v1/chat/completions:', error);
            res.status(500).json({
                error: { message: 'Erro ao interagir com o Meta AI: ' + error.message, type: 'server_error' }
            });
        } finally {
            processNextInQueue();
        }
    };

    requestQueue.push(executeChat);
    if (!isProcessing) {
        isProcessing = true;
        processNextInQueue();
    }
});

// =========================================
// ENDPOINT OPENAI-COMPATÍVEL: GET /v1/models
//
// Retorna a lista de modelos disponíveis no formato OpenAI. O ChatSET
// chama este endpoint ao clicar "Carregar modelos" no painel master.
// =========================================
app.get('/v1/models', autenticarToken, (req, res) => {
    res.json({
        object: 'list',
        data: [
            {
                id: 'meta-ai',
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'meta',
                name: 'Meta AI (Llama)',
                context_length: 4096,
                output_modalities: ['text']
            }
        ]
    });
});

// =========================================
// ENDPOINTS ORIGINAIS (mantidos para o frontend local e compatibilidade)
// =========================================

app.post('/api/chat', autenticarToken, (req, res) => {
    const { prompt, newChat, clientId } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'O campo prompt é obrigatório.' });
    }

    const executeChat = async () => {
        try {
            const reply = await enviarPromptMetaAi(prompt, newChat, clientId);
            res.json({ reply });
        } catch (error) {
            console.error('Erro no /api/chat:', error);
            res.status(500).json({ error: 'Erro ao interagir com o bot: ' + error.message });
        } finally {
            processNextInQueue();
        }
    };

    requestQueue.push(executeChat);
    if (!isProcessing) {
        isProcessing = true;
        processNextInQueue();
    }
});

app.post('/api/reset', autenticarToken, async (req, res) => {
    try {
        if (!page) throw new Error('Navegador não inicializado.');

        console.log("Reiniciando a conversa...");
        // Clica no botão "Nova conversa"
        const clicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('div, span, button'));
            const newChatBtn = elements.find(el => el.innerText && el.innerText.includes('Nova conversa'));
            if (newChatBtn) {
                newChatBtn.click();
                return true;
            }
            return false;
        });

        if (!clicked) {
            // Se não achar o botão, recarrega a página
            await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2' });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =========================================
// ENCERRAMENTO E INICIALIZAÇÃO
// =========================================

process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});

app.listen(port, async () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log(`Endpoints OpenAI-compatíveis: POST /v1/chat/completions | GET /v1/models`);
    console.log(`Endpoints originais: POST /api/chat | POST /api/reset`);
    if (process.env.API_TOKEN) {
        console.log('Autenticação por token ATIVA.');
    } else {
        console.log('Autenticação por token DESATIVADA (defina API_TOKEN para ativar).');
    }
    await initBrowser();
});
