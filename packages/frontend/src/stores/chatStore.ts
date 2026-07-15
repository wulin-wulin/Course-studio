import { create } from "zustand";

interface ChatStore {
  activeConversationId: string | null;
  selectedModel: string;

  createConversation: () => string;
  setActiveConversation: (id: string) => void;
  setModel: (model: string) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  activeConversationId: null,
  selectedModel: "",

  createConversation: () => {
    const id = crypto.randomUUID();
    set({ activeConversationId: id });
    return id;
  },

  setActiveConversation: (id) => set({ activeConversationId: id }),

  setModel: (model) => set({ selectedModel: model }),
}));
