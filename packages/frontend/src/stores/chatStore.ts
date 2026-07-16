import { create } from "zustand";

export type ChatMode = "chat" | "agent";

interface ChatStore {
  activeConversationId: string | null;
  selectedModel: string;
  mode: ChatMode;

  createConversation: () => string;
  setActiveConversation: (id: string) => void;
  setModel: (model: string) => void;
  setMode: (mode: ChatMode) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  activeConversationId: null,
  selectedModel: "",
  mode: "chat",

  createConversation: () => {
    const id = crypto.randomUUID();
    set({ activeConversationId: id });
    return id;
  },

  setActiveConversation: (id) => set({ activeConversationId: id }),

  setModel: (model) => set({ selectedModel: model }),

  setMode: (mode) => set({ mode }),
}));
