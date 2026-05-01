export const LOADGEN_CONFIGS = {
  heimdall: {
    apiUrl: import.meta.env.VITE_HEIMDALL_API_URL || '',
    apiKey: import.meta.env.VITE_HEIMDALL_API_KEY || ''
  },
  nlb: {
    apiUrl: import.meta.env.VITE_NLB_API_URL || '',
    apiKey: import.meta.env.VITE_NLB_API_KEY || ''
  }
};
