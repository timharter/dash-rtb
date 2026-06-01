export const LOADGEN_CONFIGS = {
  rtbfabric: {
    apiUrl: import.meta.env.VITE_RTBFABRIC_API_URL || '',
    apiKey: import.meta.env.VITE_RTBFABRIC_API_KEY || ''
  },
  nlb: {
    apiUrl: import.meta.env.VITE_NLB_API_URL || '',
    apiKey: import.meta.env.VITE_NLB_API_KEY || ''
  }
};
