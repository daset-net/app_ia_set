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
    let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
    if (!token && req.headers['x-api-key']) {
        token = req.headers['x-api-key'].trim();
    }
    if (!token && req.query && req.query.token) {
        token = req.query.token.trim();
    }

    if (token !== API_TOKEN) {
        return res.status(401).json({ error: 'Token inválido ou ausente.' });
    }
    next();
}

// =========================================
// CONTROLE DE MODO DE OPERAÇÃO (ENV: MODO=RAPIDO ou MODO=LENTO)
// =========================================
function getConfigModo() {
    const modo = (process.env.MODO || 'RAPIDO').trim().toUpperCase();
    if (modo === 'LENTO') {
        return {
            nome: 'LENTO',
            checkIntervalMs: 500,       // Intervalo de verificação
            minUnchangedCycles: 4,      // 4 * 500ms = 2.0s estável para finalizar
            typeDelayMs: 250,           // Espera pós-digitação
            enterDelayMs: 300,          // Espera pós-enter
            maxWaitCycles: 240          // Timeout 120s
        };
    }
    // Padrão: MODO=RAPIDO (Instantâneo / Alta Velocidade)
    return {
        nome: 'RAPIDO',
        checkIntervalMs: 200,           // Intervalo rápido (200ms)
        minUnchangedCycles: 3,          // 3 * 200ms = 600ms estável para captura imediata
        typeDelayMs: 80,                // Espera instantânea pós-digitação
        enterDelayMs: 150,              // Espera instantânea pós-enter
        maxWaitCycles: 350              // Timeout 70s (suporta Pensativo/Raciocínio longo)
    };
}

// Endpoint para fornecer configurações, API_TOKEN e MODO para a interface web frontend
app.get('/api/config', (req, res) => {
    const configModo = getConfigModo();
    res.json({
        hasToken: !!process.env.API_TOKEN,
        apiToken: process.env.API_TOKEN || '',
        modo: configModo.nome
    });
});


// =========================================
// INICIALIZAÇÃO DO NAVEGADOR
// =========================================
let isBrowserReady = false;
let browserInitPromise = null;

async function ensureBrowserReady() {
    if (isBrowserReady && page) return page;
    if (browserInitPromise) {
        await browserInitPromise;
        return page;
    }
    browserInitPromise = initBrowser();
    await browserInitPromise;
    return page;
}

async function initBrowser() {
    console.log('Iniciando Puppeteer Stealth para Meta AI...');
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: path.join(__dirname, 'user_data'),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // Injetar cookies via Variável de Ambiente ou Arquivo
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

        console.log('Acessando meta.ai...');
        await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2', timeout: 60000 });
        isBrowserReady = true;
        console.log('Navegador pronto! Sessão Meta AI ativa.');
    } catch (e) {
        console.error('Erro na inicialização do navegador:', e);
    }
}

// =========================================
// NÚCLEO: ENVIAR PROMPT AO META AI E OBTER RESPOSTA
// =========================================
async function enviarPromptMetaAi(prompt, newChat, clientId) {
    await ensureBrowserReady();
    if (!page) throw new Error('Navegador não inicializado.');

    const configModo = getConfigModo();
    const logPrefix = clientId ? `[Cliente: ${clientId}]` : `[API - ${configModo.nome}]`;
    console.log(`${logPrefix} Processando requisição (Modo: ${configModo.nome})...`);

    // Fecha qualquer popup/modal aberto
    try {
        await page.keyboard.press('Escape');
    } catch(e) {}

    // Limpa o contexto (Nova Conversa) se estiver em chat anterior (/prompt/ ou /c/)
    if (newChat !== false) {
        console.log(`${logPrefix} Verificando contexto (Nova Conversa)...`);
        try {
            const currentUrl = page.url();
            if (currentUrl.includes('/prompt/') || currentUrl.includes('/c/')) {
                const clicked = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll('div, span, button, a'));
                    const newChatBtn = elements.find(el => {
                        const txt = (el.innerText || '').toLowerCase();
                        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                        return (txt.includes('nova conversa') || txt.includes('new chat') || aria.includes('new chat') || aria.includes('nova conversa')) && el.offsetParent !== null;
                    });
                    if (newChatBtn) {
                        newChatBtn.click();
                        return true;
                    }
                    return false;
                });

                if (!clicked) {
                    await page.goto('https://www.meta.ai/', { waitUntil: 'domcontentloaded' });
                }
                await new Promise(r => setTimeout(r, 400));
            }
        } catch(e) {
            console.log(`${logPrefix} Aviso ao limpar contexto:`, e.message);
        }
    }

    // 1. Procurar e focar na caixa de texto com espera inteligente
    let inputFound = false;
    for (let attempt = 0; attempt < 25; attempt++) {
        inputFound = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea, div[role="textbox"]'));
            const mainInput = inputs.find(el => {
                const txt = (el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
                return !txt.includes('search') && !txt.includes('pesquisar');
            }) || inputs[inputs.length - 1];

            if (mainInput) {
                mainInput.focus();
                mainInput.click();
                return true;
            }
            return false;
        });

        if (inputFound) break;
        await new Promise(r => setTimeout(r, 200));
    }

    if (!inputFound) {
        console.log(`${logPrefix} Caixa de texto não encontrada. Recarregando meta.ai...`);
        try {
            await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2', timeout: 30000 });
            for (let attempt = 0; attempt < 25; attempt++) {
                inputFound = await page.evaluate(() => {
                    const inputs = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea, div[role="textbox"]'));
                    const mainInput = inputs[inputs.length - 1];
                    if (mainInput) {
                        mainInput.focus();
                        mainInput.click();
                        return true;
                    }
                    return false;
                });
                if (inputFound) break;
                await new Promise(r => setTimeout(r, 200));
            }
        } catch(e) {
            console.log(`${logPrefix} Erro no reload de recuperação:`, e.message);
        }
    }

    if (!inputFound) {
        throw new Error("Não foi possível encontrar a caixa de texto da Meta AI.");
    }

    // 2. Inserir o texto instantaneamente
    await page.evaluate((text) => {
        const inputs = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea, div[role="textbox"]'));
        const mainInput = inputs.find(el => {
            const txt = (el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
            return !txt.includes('search') && !txt.includes('pesquisar');
        }) || inputs[inputs.length - 1];

        if (mainInput) {
            mainInput.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
            mainInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, prompt);

    await new Promise(r => setTimeout(r, configModo.typeDelayMs));

    // 3. Enviar (Enter e fallback no botão)
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, configModo.enterDelayMs));

    await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const sendBtn = buttons.find(b => {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            return (label.includes('send') || label.includes('enviar') || label.includes('submit')) && !b.disabled;
        }) || buttons.find(b => b.querySelector('svg path') && !b.disabled && b.offsetWidth < 60 && b.offsetHeight < 60);

        if (sendBtn) {
            sendBtn.click();
        }
    });

    // 4. Aguardar a resposta com polling dinâmico de acordo com o MODO
    console.log(`${logPrefix} Aguardando resposta da Meta AI...`);

    let lastLength = 0;
    let unchangedCount = 0;
    let hasStarted = false;
    const checkIntervalMs = configModo.checkIntervalMs;
    const maxWaitCycles = configModo.maxWaitCycles;
    const minCycles = configModo.minUnchangedCycles;

    const sidebarBanned = [
        'search for a command',
        'nova conversa',
        'pesquisar',
        'mídia',
        'artefatos',
        'programados',
        'vibes',
        'histórico',
        'where should we start',
        'mostrar raciocínio',
        'show reasoning',
        'fontes',
        'sources',
        'thinking',
        'pensando',
        'pensativo',
        'pesquisando',
        'buscando',
        'gerando',
        'pergunte à meta ai',
        'ask meta ai'
    ];

    let finalResponse = '';

    for (let i = 0; i < maxWaitCycles; i++) {
        await new Promise(r => setTimeout(r, checkIntervalMs));

        const extracted = await page.evaluate((userPrompt, bannedList) => {
            const normalize = (str) => (str || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const cleanNorm = normalize(userPrompt);
            const snippetNorm = cleanNorm.length > 8 ? cleanNorm.substring(0, 8) : cleanNorm;

            const bodyText = document.body.innerText || '';
            const lowerBody = bodyText.toLowerCase();

            // Detecta se a IA está no modo Pensativo, pesquisando na web ou gerando raciocínio
            const isThinking = lowerBody.includes('thinking') || 
                               lowerBody.includes('pensando') || 
                               lowerBody.includes('pensativo') ||
                               lowerBody.includes('mostrar raciocínio') ||
                               lowerBody.includes('show reasoning') ||
                               lowerBody.includes('pesquisando') ||
                               lowerBody.includes('buscando') ||
                               lowerBody.includes('searching') ||
                               lowerBody.includes('gerando') ||
                               lowerBody.includes('generating');

            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const isGenerating = buttons.some(b => {
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                const text = (b.innerText || '').toLowerCase();
                return aria.includes('stop') || aria.includes('parar') || text.includes('stop') || text.includes('parar');
            });

            // 1. Localiza a mensagem do usuário com normalização de espaços e quebras de linha
            const allElements = Array.from(document.querySelectorAll('div, p, span, li, h1, h2, h3'));
            let userEl = null;
            for (let idx = allElements.length - 1; idx >= 0; idx--) {
                const el = allElements[idx];
                const txt = normalize(el.innerText);
                if (txt === cleanNorm || (snippetNorm && txt.startsWith(snippetNorm) && txt.length < cleanNorm.length + 30)) {
                    userEl = el;
                    break;
                }
            }

            // 2. Extrai todos os blocos de texto (parágrafos, listas, citações)
            const candidates = Array.from(document.querySelectorAll('p, li, div[dir="auto"], pre, blockquote, ol > li, ul > li'));
            
            // Filtra os elementos que vêm DEPOIS da mensagem do usuário
            const afterElements = candidates.filter(el => {
                if (userEl) {
                    if (userEl === el || userEl.contains(el)) return false;
                    const pos = userEl.compareDocumentPosition(el);
                    if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
                }
                return true;
            });

            let parts = [];
            for (const el of afterElements) {
                const originalTxt = (el.innerText || '').trim();
                if (!originalTxt) continue;
                const lower = originalTxt.toLowerCase();

                if (bannedList.some(b => lower === b || lower.startsWith('mostrar raciocínio') || lower.startsWith('show reasoning') || lower.includes('search for a command'))) continue;
                if (normalize(originalTxt) === cleanNorm || normalize(originalTxt).includes(cleanNorm)) continue;

                // Formata listas com marcador se for tag LI e não tiver numeração própria
                let formattedTxt = originalTxt;
                if (el.tagName === 'LI' && !formattedTxt.startsWith('•') && !formattedTxt.startsWith('-') && !/^\d+\./.test(formattedTxt)) {
                    formattedTxt = `• ${formattedTxt}`;
                }

                // Evita duplicações de elementos pai e filho
                if (!parts.some(p => p === formattedTxt || p.includes(originalTxt))) {
                    parts.push(formattedTxt);
                }
            }

            let responseText = parts.join('\n\n');

            // Fallback se userEl não foi localizado: extrai os blocos válidos da página
            if (!responseText) {
                const validList = candidates
                    .map(el => (el.innerText || '').trim())
                    .filter(t => {
                        if (t.length < 5) return false;
                        const lower = t.toLowerCase();
                        if (normalize(t) === cleanNorm || (snippetNorm && normalize(t).includes(snippetNorm))) return false;
                        return !bannedList.some(b => lower.includes(b));
                    });

                if (validList.length > 0) {
                    responseText = [...new Set(validList)].join('\n\n');
                }
            }

            return {
                text: responseText.trim(),
                isThinking,
                isGenerating
            };
        }, prompt, sidebarBanned);

        const currentText = extracted.text;
        const isThinking = extracted.isThinking;
        const isGenerating = extracted.isGenerating;

        if (currentText.length > lastLength + 2) {
            if (!isThinking) hasStarted = true;
            lastLength = currentText.length;
            unchangedCount = 0;
        } else {
            unchangedCount++;
        }

        // Se estiver pensando ou gerando na web, não deixa o timeout de ociosidade disparar
        if (isThinking || isGenerating) {
            unchangedCount = 0;
        }

        if (hasStarted && currentText.length > 0 && !isThinking && !isGenerating && unchangedCount >= minCycles) {
            console.log(`${logPrefix} Resposta capturada no modo ${configModo.nome} em ${((i + 1) * checkIntervalMs) / 1000}s (${currentText.length} caracteres).`);
            finalResponse = currentText;
            break;
        }

        // Timeout apenas após pelo menos 40 segundos sem início se não estiver pensando
        if (!hasStarted && !isThinking && unchangedCount >= 200) {
            console.log(`${logPrefix} Timeout na resposta (40s sem início de resposta).`);
            finalResponse = currentText;
            break;
        }
    }

    if (!finalResponse) {
        throw new Error("A Meta AI não retornou uma resposta a tempo. Por favor, tente enviar novamente.");
    }

    console.log(`${logPrefix} Resposta final pronta (${finalResponse.length} caracteres).`);

    lastDebugInfo = {
        timestamp: new Date().toISOString(),
        response: finalResponse,
        length: finalResponse.length
    };

    return finalResponse;
}

// =========================================
// CONVERSÃO DE MENSAGENS OPENAI → PROMPT ÚNICO
// =========================================
function mensagensParaPrompt(messages) {
    if (!messages || messages.length === 0) return '';

    // Se for apenas uma mensagem direta do usuário
    if (messages.length === 1 && messages[0].role === 'user') {
        return messages[0].content || '';
    }

    const partes = [];
    for (const msg of messages) {
        const role = msg.role || '';
        const content = msg.content || '';
        if (!content) continue;

        if (role === 'system') {
            partes.push('Instruções:\n' + content);
        } else if (role === 'user') {
            partes.push('Usuário: ' + content);
        } else if (role === 'assistant') {
            partes.push('Assistente: ' + content);
        } else if (role === 'tool') {
            partes.push('Dados:\n' + content);
        }
    }

    if (partes.length === 1) {
        return messages[0].content || '';
    }

    return partes.join('\n\n');
}

// =========================================
// ENDPOINT OPENAI-COMPATÍVEL: POST /v1/chat/completions
// =========================================
app.post('/v1/chat/completions', autenticarToken, (req, res) => {
    const { messages, model, newChat } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: { message: 'O campo messages é obrigatório e deve ser um array não vazio.', type: 'invalid_request_error' }
        });
    }

    const prompt = mensagensParaPrompt(messages);
    if (!prompt) {
        return res.status(400).json({
            error: { message: 'Nenhuma mensagem com conteúdo foi encontrada.', type: 'invalid_request_error' }
        });
    }

    const clientId = `openai-compat`;

    const executeChat = async () => {
        try {
            const reply = await enviarPromptMetaAi(prompt, newChat !== false, clientId);

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
    const configModo = getConfigModo();
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log(`Modo de Operação: [MODO=${configModo.nome}] (${configModo.nome === 'RAPIDO' ? 'Instantâneo / Alta Velocidade' : 'Conservador / Lento'})`);
    console.log(`Endpoints OpenAI-compatíveis: POST /v1/chat/completions | GET /v1/models`);
    console.log(`Endpoints originais: POST /api/chat | POST /api/reset`);
    if (process.env.API_TOKEN) {
        console.log('Autenticação por token ATIVA.');
    } else {
        console.log('Autenticação por token DESATIVADA (defina API_TOKEN para ativar).');
    }
    await initBrowser();
});
