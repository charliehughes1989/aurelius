import { processAutomation } from './AutomationEngine.ts';

let running = false;

export async function runAutomationWorker() {
  if (running) return;

  running = true;

  try {
    const result = processAutomation();
    console.log(
      `[Aurelius Automation] processed ${result.processed} clients at ${result.timestamp}`
    );
  } catch (error) {
    console.error('[Aurelius Automation] worker error',error);
  } finally {
    running = false;
  }
}

export function startAutomationWorker() {
  // Run shortly after startup.
  setTimeout(() => {
    runAutomationWorker();
  }, 5000);

  // Re-run periodically.
  setInterval(() => {
    runAutomationWorker();
  }, 15 * 60 * 1000);
}
