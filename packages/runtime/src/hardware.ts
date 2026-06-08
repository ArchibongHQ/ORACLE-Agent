import { execFileSync } from "node:child_process";

export interface HardwareCapabilities {
  hasNvidiaGpu: boolean;
  gpuName: string | null;
  isVps: boolean;
  cudaVersion: string | null;
}

export function detectHardware(): HardwareCapabilities {
  let hasNvidiaGpu = false;
  let gpuName: string | null = null;
  let cudaVersion: string | null = null;

  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,driver_version", "--format=csv,noheader"],
      { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    if (out) {
      hasNvidiaGpu = true;
      gpuName = out.split(",")[0].trim();
    }
  } catch {
    /* nvidia-smi absent or no NVIDIA GPU */
  }

  try {
    const match = execFileSync("nvcc", ["--version"], {
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .match(/release (\S+),/);
    cudaVersion = match?.[1] ?? null;
  } catch {
    /* CUDA toolkit not installed */
  }

  // Prefer env override (works on Windows where systemd-detect-virt is unavailable)
  let isVps = process.env.ORACLE_IS_VPS === "true";
  if (!isVps) {
    try {
      const virt = execFileSync("systemd-detect-virt", [], {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      isVps = virt !== "none" && virt !== "";
    } catch {
      /* not a systemd host */
    }
  }

  return { hasNvidiaGpu, gpuName, isVps, cudaVersion };
}

/** True when GPU-bound features (autoresearch loop, local embeddings, classifier fine-tuning) should activate. */
export function isGpuCapable(caps: HardwareCapabilities): boolean {
  return caps.hasNvidiaGpu || caps.isVps;
}
