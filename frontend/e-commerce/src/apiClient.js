import axios from "axios";
import { startAuthentication } from "@simplewebauthn/browser";

const apiClient = axios.create({ baseURL: "/api" });

// Global state for interceptor concurrency
let isStepUpInProgress = false;
let requestBuffer = [];

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const responseData = error.response?.data;

    // Catch the 'High-Assurance' requirement error
    if (
      error.response?.status === 401 &&
      responseData?.code === "REAUTHENTICATION_REQUIRED"
    ) {
      // 1. Queue logic: if a biometric prompt is already on screen, wait.
      if (isStepUpInProgress) {
        return new Promise((resolve) => {
          requestBuffer.push(() => resolve(apiClient(originalRequest)));
        });
      }

      isStepUpInProgress = true;

      try {
        // 2. Fetch hardware-bound challenge
        const { data: options } = await apiClient.post(
          "/auth/webauthn/options",
          {
            userId: responseData.payload.userId,
          }
        );

        // 3. Native Browser/OS Prompt (TouchID, FaceID, Windows Hello)
        const assertion = await startAuthentication(options);

        // 4. Verification & Session Escalation
        await apiClient.post("/auth/webauthn/stepup", {
          userId: responseData.payload.userId,
          assertionResponse: assertion,
        });

        isStepUpInProgress = false;

        // 5. Success: Release the floodgates for queued requests
        const retryQueue = [...requestBuffer];
        requestBuffer = [];
        retryQueue.forEach((retry) => retry());

        // 6. Transparently retry the original request
        return apiClient(originalRequest);
      } catch (mfaErr) {
        isStepUpInProgress = false;
        requestBuffer = []; // Clear queue to prevent infinite loops

        // If the user cancels the biometric prompt, we should handle it gracefully
        if (mfaErr.name === "NotAllowedError") {
          console.warn("User cancelled biometric verification.");
        }

        return Promise.reject(mfaErr);
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
