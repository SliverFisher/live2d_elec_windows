export async function assertModelJson(modelUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(modelUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Unable to read model3.json: HTTP ${response.status}`);
    }

    const json = await response.json();
    if (!json || typeof json !== 'object' || Number(json.Version) < 3 || !json.FileReferences) {
      throw new Error('The selected file is not a valid Cubism model3.json.');
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Timed out while reading model3.json: ${modelUrl}`);
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
