const { createApp, ref, nextTick, onMounted } = Vue;

const app = createApp({
    setup() {
        const prompt = ref('');
        const chatHistory = ref([]);
        const isLoading = ref(false);
        const error = ref('');
        const messagesContainer = ref(null);
        const apiToken = ref('');

        const fetchConfig = async () => {
            try {
                const response = await fetch('/api/config');
                if (response.ok) {
                    const data = await response.json();
                    if (data.apiToken) {
                        apiToken.value = data.apiToken;
                    }
                }
            } catch (err) {
                console.warn('Não foi possível obter config do servidor:', err);
            }
        };

        const scrollToBottom = async () => {
            await nextTick();
            if (messagesContainer.value) {
                messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
            }
        };

        const getAuthHeaders = () => {
            const headers = { 'Content-Type': 'application/json' };
            if (apiToken.value) {
                headers['Authorization'] = `Bearer ${apiToken.value}`;
            }
            return headers;
        };

        const sendMessage = async () => {
            if (!prompt.value.trim() || isLoading.value) return;

            if (!apiToken.value) {
                await fetchConfig();
            }

            const userText = prompt.value.trim();
            chatHistory.value.push({ role: 'user', content: userText });
            prompt.value = '';
            isLoading.value = true;
            error.value = '';
            scrollToBottom();

            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ prompt: userText })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || data.message || 'Erro ao comunicar com o servidor.');
                }

                chatHistory.value.push({ role: 'bot', content: data.reply });
            } catch (err) {
                console.error(err);
                error.value = err.message;
            } finally {
                isLoading.value = false;
                scrollToBottom();
            }
        };

        const resetConversation = async () => {
            if (isLoading.value) return;
            if (!confirm("Tem certeza que deseja iniciar uma nova conversa com a Meta AI?")) return;

            if (!apiToken.value) {
                await fetchConfig();
            }

            isLoading.value = true;
            error.value = '';

            try {
                const response = await fetch('/api/reset', { 
                    method: 'POST',
                    headers: getAuthHeaders()
                });
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || data.message || 'Erro ao resetar conversa.');
                }

                chatHistory.value = [];
            } catch (err) {
                console.error(err);
                error.value = err.message;
            } finally {
                isLoading.value = false;
            }
        };

        onMounted(() => {
            fetchConfig();
        });

        return {
            prompt,
            chatHistory,
            isLoading,
            error,
            messagesContainer,
            apiToken,
            sendMessage,
            resetConversation
        };
    }
});

app.mount('#app');
