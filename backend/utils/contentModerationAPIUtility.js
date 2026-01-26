// --- contentModeration.js ---
// This module utilizes the Gemini API's native safety ratings for highly reliable
// content moderation, which is the best practice for production environments.

const apiKey = "";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// Define the safety threshold that triggers a block.
// A probability of HARM_PROBABILITY_HIGH or HARM_PROBABILITY_VERY_HIGH will result in a block.
const BLOCKED_PROBABILITY_THRESHOLD = 'HIGH';

// List of mandatory categories to block (e.g., sexual content, hate speech).
// The service checks if ANY of these exceed the threshold.
const HARMFUL_CATEGORIES_TO_BLOCK = [
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

/**
* Maps the safety rating (e.g., 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH') to a numeric score.
* This is used to determine if a category meets or exceeds the BLOCKED_PROBABILITY_THRESHOLD.
* @param {string} probability - The probability string from the API.
* @returns {number} The numeric score (higher is worse).
*/
function getProbabilityScore(probability) {
  switch (probability) {
    case 'HARM_PROBABILITY_VERY_HIGH': return 4;
    case 'HARM_PROBABILITY_HIGH': return 3;
    case 'HARM_PROBABILITY_MEDIUM': return 2;
    case 'HARM_PROBABILITY_LOW': return 1;
    default: return 0; // NEGLIGIBLE
  }
}

/**
* Checks a piece of text against content moderation policies using the API's native safety ratings.
* @param {string} text - The review text to analyze.
* @returns {Promise<{safe: boolean, reason?: string}>} Object indicating safety status and optional reason.
*/
async function checkContentSafety(text) {
  if (!text || text.trim() === '') {
    return { safe: true };
  }
 
  // 1. Quick Local Check (Minimal latency/cost)
  const blockedKeywords = ["slanderous", "sexual", "slut", "bomb", "threat", "lewd", "porn"];
  const lowerText = text.toLowerCase();
  for (const keyword of blockedKeywords) {
    if (lowerText.includes(keyword)) {
      console.warn(`[Moderation] Failed quick check: Found blocked keyword '${keyword}'.`);
      return { safe: false, reason: `Explicit keyword detected: ${keyword}` };
    }
  }

  // 2. AI-BASED CONTEXTUAL CHECK (Structured and reliable)
  const payload = {
    contents: [{ parts: [{ text }] }],
    // No custom system prompt needed; we rely on the model's inherent safety classifier
  };

  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        // Log and retry on transient API error
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const result = await response.json();
      const candidate = result.candidates?.[0];

      if (!candidate) {
        // If the model rejects the prompt before generating, check the prompt's safety feedback
        const promptFeedback = result.promptFeedback;
        if (promptFeedback?.safetyRatings?.length > 0) {
          return { safe: false, reason: "Prompt rejected by API due to high initial safety score." };
        }
        // Unexpected case, treat as failure but allow (based on your risk tolerance)
        throw new Error("API returned no candidate or prompt feedback.");
      }

      // Check the generated content's safety ratings
      const safetyRatings = candidate.safetyRatings || [];
      const thresholdScore = getProbabilityScore(`HARM_PROBABILITY_${BLOCKED_PROBABILITY_THRESHOLD}`);
     
      for (const rating of safetyRatings) {
        if (HARMFUL_CATEGORIES_TO_BLOCK.includes(rating.category)) {
          const currentScore = getProbabilityScore(rating.probability);
         
          if (currentScore >= thresholdScore) {
            console.warn(`[Moderation] BLOCKED: ${rating.category} probability: ${rating.probability}`);
            return { safe: false, reason: `${rating.category} violation (${rating.probability})` };
          }
        }
      }
     
      // If all checks pass
      return { safe: true };

    } catch (error) {
      retries++;
      // Use exponential backoff and only log on final failure
      if (retries === maxRetries) {
        console.error("[Moderation] Failed all attempts to check content safety. Allowing by default (RISK).", error);
        return { safe: true }; // Allow if service fails, or return false if block-by-default is policy.
      }
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000));
    }
  }
}

// Export the function with structured output
module.exports = {
  checkContentSafety,
};