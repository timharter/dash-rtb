import { LOADGEN_CONFIGS } from './config';

interface LoadGenConfig {
  apiUrl: string;
  apiKey: string;
}

interface StartLoadGenParams {
  duration?: string;
  devicesUsed?: string;
  numberOfJobs?: string;
  ratePerJob?: string;
}

interface DualApiResult {
  heimdall: { success: boolean; error?: string };
  nlb: { success: boolean; error?: string };
}

export async function startLoadGen(config: LoadGenConfig, params: StartLoadGenParams = {}) {
  const defaultParams = {
    duration: '10m',
    devicesUsed: '1000',
    numberOfJobs: '1',
    ratePerJob: '0'
  };

  const requestBody = { ...defaultParams, ...params };

  const response = await fetch(`${config.apiUrl}/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      // If response body isn't JSON, use status text
    }
    throw new Error(errorMessage);
  }

  return response;
}

export async function stopLoadGen(config: LoadGenConfig) {
  const response = await fetch(`${config.apiUrl}/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      // If response body isn't JSON, use status text
    }
    throw new Error(errorMessage);
  }

  return response;
}

export async function startLoadGenDual(params: StartLoadGenParams = {}): Promise<DualApiResult> {
  const results = await Promise.allSettled([
    startLoadGen(LOADGEN_CONFIGS.heimdall, params),
    startLoadGen(LOADGEN_CONFIGS.nlb, params)
  ]);

  return {
    heimdall: {
      success: results[0].status === 'fulfilled',
      error: results[0].status === 'rejected' 
        ? (results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason))
        : undefined
    },
    nlb: {
      success: results[1].status === 'fulfilled',
      error: results[1].status === 'rejected' 
        ? (results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason))
        : undefined
    }
  };
}

export async function stopLoadGenDual(): Promise<DualApiResult> {
  const results = await Promise.allSettled([
    stopLoadGen(LOADGEN_CONFIGS.heimdall),
    stopLoadGen(LOADGEN_CONFIGS.nlb)
  ]);

  return {
    heimdall: {
      success: results[0].status === 'fulfilled',
      error: results[0].status === 'rejected' 
        ? (results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason))
        : undefined
    },
    nlb: {
      success: results[1].status === 'fulfilled',
      error: results[1].status === 'rejected' 
        ? (results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason))
        : undefined
    }
  };
}

export async function startLoadGenSingle(
  env: 'heimdall' | 'nlb',
  params: StartLoadGenParams = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    await startLoadGen(LOADGEN_CONFIGS[env], params);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function stopLoadGenSingle(
  env: 'heimdall' | 'nlb'
): Promise<{ success: boolean; error?: string }> {
  try {
    await stopLoadGen(LOADGEN_CONFIGS[env]);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
