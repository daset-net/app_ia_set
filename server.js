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

app.post('/api/chat', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Texto é obrigatório.' });
    }

    if (!page) {
        return res.status(500).json({ error: 'Navegador ainda está iniciando.' });
    }

    try {
        console.log(`Enviando prompt: ${prompt}`);

        // 1. Tenta encontrar e ativar o modo "Pensativo"
        await page.evaluate(async () => {
            const spans = Array.from(document.querySelectorAll('span, div, button'));
            const pensativoEl = spans.find(el => el.innerText && el.innerText.trim() === 'Pensativo');
            
            if (pensativoEl) {
                // Tenta achar o botão "pai" clicável ou clica no próprio elemento
                const btn = pensativoEl.closest('button') || pensativoEl.closest('[role="button"]') || pensativoEl;
                
                // Se o aria-checked ou aria-selected for falso, ou se não tiver como verificar, vamos clicar por garantia
                // Para ser mais seguro, o ideal seria checar se já está ativo, mas como não temos a classe exata, clica se achar
                // Se a regra é "mudar se estiver instantâneo", vamos assumir que clicar ativa.
                try {
                    btn.click();
                    console.log('Modo pensativo clicado.');
                } catch(e) {}
            }
        });
        
        await new Promise(r => setTimeout(r, 1000));

        
        const inputFound = await page.evaluate(() => {
            const input = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
            if (input) {
                input.focus();
                return true;
            }
            return false;
        });

        if (!inputFound) throw new Error("Não foi possível encontrar a caixa de texto da Meta AI.");

        // Clica na caixa para garantir que o React registre o foco
        await page.mouse.click(500, 700); // Clique genérico no meio inferior da tela como fallback
        await page.evaluate(() => {
            const input = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
            if(input) input.click();
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
                // Sobe alguns níveis para pegar o container da barra inferior
                let parent = input.parentElement;
                for (let i = 0; i < 6; i++) {
                    if (!parent) break;
                    const buttons = Array.from(parent.querySelectorAll('div[role="button"], button'));
                    // Procura botão de send específico
                    let sendBtn = buttons.find(b => {
                        const label = (b.getAttribute('aria-label') || '').toLowerCase();
                        return label.includes('send') || label.includes('enviar');
                    });
                    
                    // Se não achou por label, pega o último botão com SVG (geralmente é o send)
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
        
        // Espera mais um pouco para o clique fazer efeito
        await new Promise(r => setTimeout(r, 1500));

        // 3. Esperar a resposta ser gerada
        console.log('Aguardando resposta da Meta AI...');
        
        let lastTextLength = 0;
        let unchangedCount = 0;
        let hasStartedAnswering = false;
        let finalResponse = ''; // Definindo a variável corretamente

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
                console.log('Timeout: A resposta não começou a ser gerada.');
                break;
            }
        }
        
        // 4. Extração fina: Como pegar exatamente a última resposta do bot?
        finalResponse = await page.evaluate((userPrompt) => {
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


        res.json({ reply: finalResponse });

    } catch (error) {
        console.error('Erro no Puppeteer:', error);
        res.status(500).json({ error: 'Erro ao interagir com o bot: ' + error.message });
    }
});

app.post('/api/reset', async (req, res) => {
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
            // Se não achar o botão, usa o atalho da imagem (Ctrl+Shift+O) ou recarrega a página
            await page.goto('https://www.meta.ai/', { waitUntil: 'networkidle2' });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});

app.listen(port, async () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    await initBrowser();
});
