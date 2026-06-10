/**
 * Executes a promise-returning function and retries it with exponential backoff if a 429 error is hit.
 * 
 * @param fn The function to execute.
 * @param retries Maximum number of retry attempts.
 * @param delay Initial delay in milliseconds.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 2000
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    // Check for standard HTTP 429 status codes
    const status = error.status || error.statusCode || error.response?.status;
    const isRateLimit = status === 429 || 
      (error.message && error.message.includes('429')) || 
      (error.message && error.message.toLowerCase().includes('resource has been exhausted'));

    if (retries > 0 && isRateLimit) {
      console.warn(`[Rate Limit] Encountered 429/Resource Exhausted. Retrying in ${delay}ms... (${retries} attempts left)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    
    throw error;
  }
}
