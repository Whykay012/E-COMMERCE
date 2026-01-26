// src/utils/notify.js
import { toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

// Success notification
export const notifySuccess = (msg) => {
  toast.success(msg, {
    position: "top-right",
    autoClose: 3000,
    hideProgressBar: false,
    newestOnTop: false,
    closeOnClick,
    rtl: false,
    pauseOnFocusLoss,
    draggable,
    pauseOnHover,
    theme: "colored",
  });
};

// Error notification
export const notifyError = (msg) => {
  toast.error(msg, {
    position: "top-right",
    autoClose: 3000,
    hideProgressBar: false,
    newestOnTop: false,
    closeOnClick,
    rtl: false,
    pauseOnFocusLoss,
    draggable,
    pauseOnHover,
    theme: "colored",
  });
};
