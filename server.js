const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

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
        headless: false, // Deixando false para o usuário poder logar se necessário na primeira vez
        userDataDir: path.join(__dirname, 'user_data'), // Salva a sessão
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
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

        // 2. Preencher o texto (procura por textarea ou contenteditable)
        const inputHandled = await page.evaluate((text) => {
            // Tenta achar a textarea pelo placeholder
            let input = document.querySelector('textarea[placeholder*="Pergunte"]');
            if (!input) input = document.querySelector('textarea');
            if (!input) input = document.querySelector('div[contenteditable="true"]');
            
            if (input) {
                input.focus();
                // Usando execCommand para inserir texto como se fosse digitado
                document.execCommand('insertText', false, text);
                return true;
            }
            return false;
        }, prompt);

        if (!inputHandled) {
            throw new Error("Não foi possível encontrar a caixa de texto da Meta AI.");
        }

        await new Promise(r => setTimeout(r, 500));

        // Enviar (pressionar Enter)
        await page.keyboard.press('Enter');

        // 3. Esperar a resposta ser gerada
        // Vamos monitorar a página até a resposta parar de crescer (esperando 3 segundos sem mudança no texto da página)
        console.log('Aguardando resposta da Meta AI...');
        
        let lastTextLength = 0;
        let unchangedCount = 0;
        let finalResponse = '';

        // Espera no máximo 60 segundos
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            
            const currentResponse = await page.evaluate(() => {
                // Tenta extrair todas as mensagens do bot. Geralmente elas estão em divs específicas.
                // Como não sabemos a classe, pegaremos a última bolha grande de texto que não foi a nossa pergunta
                // ou simplesmente pegaremos a mudança no texto da página
                
                // Uma estratégia melhor é achar elementos que possuam muito texto gerado
                // Vamos tentar achar a última resposta do assistente (geralmente dentro de um article ou div grande)
                const paragraphs = Array.from(document.querySelectorAll('p, span[dir="auto"], div[dir="auto"]'));
                if (paragraphs.length === 0) return '';
                
                // Pega os últimos elementos de texto e concatena (simplificação heurística)
                // O Meta AI geralmente usa roles de "article" ou divs bem aninhadas.
                // Vamos pegar o texto visível e tentar separar.
                return document.body.innerText;
            });

            if (currentResponse.length > lastTextLength) {
                lastTextLength = currentResponse.length;
                unchangedCount = 0; // reset
            } else if (currentResponse.length > 0 && currentResponse.length === lastTextLength) {
                unchangedCount++;
            }

            // Se o texto não mudou por 6 segundos (3 iterações de 2s)
            if (unchangedCount >= 3) {
                break;
            }
        }
        
        // 4. Extração fina: Como pegar exatamente a última resposta do bot?
        finalResponse = await page.evaluate((userPrompt) => {
            // Tenta pegar todas as divs que parecem ser mensagens.
            // O Meta AI coloca a mensagem do usuário e do bot sequencialmente.
            // Pegaremos o último bloco de texto grande que não contém o nosso prompt.
            const allTextNodes = Array.from(document.querySelectorAll('div[dir="auto"]'));
            
            // Filtra nós relevantes e ignora caixas muito curtas ou irrelevantes
            const texts = allTextNodes.map(n => n.innerText).filter(t => t.length > 5);
            
            if (texts.length > 0) {
                // A última mensagem do assistente costuma ser o último texto longo
                // Vamos pegar os últimos textos e tentar montar
                // Ignorar o prompt do usuário se estiver no final (as vezes repete)
                for (let i = texts.length - 1; i >= 0; i--) {
                    if (texts[i].includes(userPrompt)) {
                        continue;
                    }
                    if (texts[i].length > 20) {
                        return texts[i];
                    }
                }
                return texts[texts.length - 1]; // fallback
            }
            return "Não foi possível extrair a resposta precisa.";
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
