const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// Intercepta os logs para colocar a data e hora no final (padrão brasileiro)
const originalConsoleLog = console.log;
console.log = function(...args) {
    const now = new Date();
    // Subtrai 3 horas para fuso de Brasília caso o servidor do Easypanel esteja em UTC
    const offset = -3;
    const localTime = new Date(now.getTime() + offset * 3600 * 1000);
    
    const pad = (n) => n.toString().padStart(2, '0');
    const ts = `${pad(localTime.getUTCDate())}/${pad(localTime.getUTCMonth()+1)}/${localTime.getUTCFullYear()} ${pad(localTime.getUTCHours())}:${pad(localTime.getUTCMinutes())}:${pad(localTime.getUTCSeconds())}`;
    
    originalConsoleLog(...args, ts);
};
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
        try {
            // Ir para a raiz força o Meta AI a sair da conversa atual (/c/...) e abrir uma nova
            await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));
        } catch(e) {
            console.log(`${logPrefix} Erro ao limpar contexto:`, e.message);
        }
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

    // 2. Inserir o texto instantaneamente (evita timeout em prompts longos com histórico)
    await page.evaluate((text) => {
        const input = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
        if (input) {
            // execCommand 'insertText' simula um "colar" e dispara eventos onChange do React
            document.execCommand('insertText', false, text);
        }
    }, prompt);

    // Espera o React processar o texto colado
    await new Promise(r => setTimeout(r, 500));

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

        if (currentResponse.length > lastTextLength + 5) {
            if (lastTextLength > 0 && !isThinking) hasStartedAnswering = true;
            lastTextLength = currentResponse.length;
            unchangedCount = 0; // Reset, texto crescendo de verdade
        } else if (Math.abs(currentResponse.length - lastTextLength) <= 5) {
            unchangedCount++; // Texto parou ou está só piscando cursor
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

    // 4. Extração fina da resposta usando a estrutura do DOM
    const finalResponse = await page.evaluate((userPrompt) => {
        // Encontra todos os elementos que contêm o texto do prompt original
        // O prompt original começa com "Contexto e Regras do Atendimento:"
        const promptMarker = "Contexto e Regras do Atendimento:";
        
        // Pega todas as divs na tela
        const allDivs = Array.from(document.querySelectorAll('div[dir="auto"]'));
        
        // Acha o último elemento que é a mensagem do usuário (que contém o marcador)
        let lastUserMessageIndex = -1;
        for (let i = allDivs.length - 1; i >= 0; i--) {
            if (allDivs[i].innerText && allDivs[i].innerText.includes(promptMarker)) {
                lastUserMessageIndex = i;
                break;
            }
        }
        
        if (lastUserMessageIndex !== -1) {
            // A resposta da IA são as divs [dir="auto"] que vêm DEPOIS da mensagem do usuário
            // Vamos pegar todas as divs subsequentes até acabar ou encontrar outra mensagem do usuário
            let aiTextParts = [];
            for (let i = lastUserMessageIndex + 1; i < allDivs.length; i++) {
                const text = allDivs[i].innerText.trim();
                // Ignora textos de UI curtos ou placeholders
                if (text.length > 0 && !text.includes('Pergunte à Meta AI') && !text.includes(promptMarker)) {
                    aiTextParts.push(text);
                }
            }
            
            if (aiTextParts.length > 0) {
                // Junta todas as partes. Remove duplicações (as vezes divs aninhadas repetem texto)
                const uniqueParts = [...new Set(aiTextParts)];
                // Filtra o botão "Mostrar raciocínio"
                const cleanedParts = uniqueParts.filter(p => !p.includes('Mostrar raciocínio') && !p.includes('Thinking'));
                
                // Se sobrar algo, retorna
                if (cleanedParts.length > 0) {
                    return cleanedParts.join('\n\n');
                }
            }
        }

        // Fallback: se não achar a mensagem do usuário, pega os últimos parágrafos grandes da tela
        const allParagraphs = Array.from(document.querySelectorAll('p, div[dir="auto"] > span'));
        const texts = allParagraphs.map(p => p.innerText.trim()).filter(t => t.length > 40 && !t.includes(promptMarker));
        
        if (texts.length > 0) {
            // Pega os últimos 3 textos longos (provavelmente formam a última resposta)
            return texts.slice(-3).join('\n\n');
        }

        const rawText = document.body.innerText;
        return rawText.length > 600 ? rawText.substring(rawText.length - 600) : rawText;
    }, prompt);

    console.log(`${logPrefix} Resposta obtida (${finalResponse.length} caracteres).`);
    
    // Salva para debug
    lastDebugInfo = {
        timestamp: new Date().toISOString(),
        response: finalResponse,
        // Evita salvar rawText gigante aqui na memória, salva só tamanho
        length: finalResponse.length
    };

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

app.get('/api/reset', async (req, res) => {
    try {
        if (page) {
            await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2', timeout: 60000 });
            res.json({ success: true, message: 'Página recarregada com sucesso.' });
        } else {
            res.status(400).json({ success: false, error: 'Navegador não está rotando.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

let lastDebugInfo = { timestamp: null, response: null, rawText: null };

// Rota de debug para diagnosticar o extrator
app.get('/v1/debug', (req, res) => {
    res.json(lastDebugInfo);
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
