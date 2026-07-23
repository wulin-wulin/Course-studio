import { create } from "zustand";

const ACTIVE_CONVERSATION_KEY = "course-studio:active-conversation";

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
  activeConversationId: readStoredConversationId(),
  selectedModel: "",
  mode: "chat",

  createConversation: () => {
    const id = crypto.randomUUID();
    storeConversationId(id);
    set({ activeConversationId: id });
    return id;
  },

  setActiveConversation: (id) => {
    storeConversationId(id);
    set({ activeConversationId: id });
  },

  setModel: (model) => set({ selectedModel: model }),

  setMode: (mode) => set({ mode }),
}));

function readStoredConversationId() {
  try {
    const value = window.localStorage.getItem(ACTIVE_CONVERSATION_KEY)?.trim() ?? "";
    return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeConversationId(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
  } catch {
    // The in-memory store remains usable when browser storage is unavailable.
  }
}
