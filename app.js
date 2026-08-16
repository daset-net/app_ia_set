const { createApp, ref, nextTick } = Vue;

const app = createApp({
    setup() {
        const prompt = ref('');
        const chatHistory = ref([]);
        const isLoading = ref(false);
        const error = ref('');
        const messagesContainer = ref(null);

        const scrollToBottom = async () => {
            await nextTick();
            if (messagesContainer.value) {
                messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
            }
        };

        const sendMessage = async () => {
            if (!prompt.value.trim() || isLoading.value) return;

            const userText = prompt.value.trim();
            chatHistory.value.push({ role: 'user', content: userText });
            prompt.value = '';
            isLoading.value = true;
            error.value = '';
            scrollToBottom();

            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: userText })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Erro ao comunicar com o servidor.');
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

            isLoading.value = true;
            error.value = '';

            try {
                const response = await fetch('/api/reset', { method: 'POST' });
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Erro ao resetar conversa.');
                }

                chatHistory.value = [];
            } catch (err) {
                console.error(err);
                error.value = err.message;
            } finally {
                isLoading.value = false;
            }
        };

        return {
            prompt,
            chatHistory,
            isLoading,
            error,
            messagesContainer,
            sendMessage,
            resetConversation
        };
    }
});

app.mount('#app');
