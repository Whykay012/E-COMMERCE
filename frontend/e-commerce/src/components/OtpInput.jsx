// src/components/OtpInput.jsx
import React, { useRef, useEffect } from "react";

export default function OtpInput({ otp, onChange, onComplete }) {
  const inputsRef = useRef([]);

  useEffect(() => {
    // Focus the first empty input on mount
    const firstEmpty = otp.findIndex((d) => !d);
    inputsRef.current[firstEmpty >= 0 ? firstEmpty : otp.length - 1]?.focus();
  }, [otp]);

  const handleChange = (e, index) => {
    const value = e.target.value.replace(/\D/g, ""); // only digits
    if (!value) return;

    // Only take the first digit if user typed multiple
    const digit = value[0];
    onChange(index, digit);

    // Move to next input
    if (index < otp.length - 1) {
      inputsRef.current[index + 1]?.focus();
    }

    // Check if OTP is complete
    const newOtp = [...otp];
    newOtp[index] = digit;
    if (newOtp.every((d) => d !== "")) onComplete?.(newOtp.join(""));
  };

  const handleKeyDown = (e, index) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (otp[index]) {
        onChange(index, "");
      } else if (index > 0) {
        onChange(index - 1, "");
        inputsRef.current[index - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputsRef.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < otp.length - 1) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    const pasteData = e.clipboardData.getData("text").replace(/\D/g, "");
    for (let i = 0; i < otp.length; i++) {
      onChange(i, pasteData[i] || "");
    }
    const lastIndex = Math.min(pasteData.length, otp.length) - 1;
    inputsRef.current[lastIndex]?.focus();

    // Check if OTP is complete
    if (pasteData.length >= otp.length)
      onComplete?.(pasteData.slice(0, otp.length));
  };

  return (
    <div onPaste={handlePaste} className="flex gap-2">
      {otp.map((digit, index) => (
        <input
          key={index}
          ref={(el) => (inputsRef.current[index] = el)}
          value={digit}
          onChange={(e) => handleChange(e, index)}
          onKeyDown={(e) => handleKeyDown(e, index)}
          maxLength={1}
          type="text"
          className="w-12 h-12 text-center text-xl border rounded focus:ring-2 focus:ring-blue-400"
          aria-label={`OTP digit ${index + 1}`}
        />
      ))}
    </div>
  );
}
