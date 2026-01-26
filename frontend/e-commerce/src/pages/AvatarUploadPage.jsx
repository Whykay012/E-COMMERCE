import React, { useState } from "react";
import FileUpload from "./FileUpload";
import { useDispatch, useSelector } from "react-redux";
import { uploadAvatar, clearUploadState } from "../redux/slices/uplaodSlice";
import { notifyError, notifySuccess } from "../utils/notify";

export default function AvatarUploadPage() {
  const dispatch = useDispatch();
  const { loading, error, lastResult } = useSelector((s) => s.upload);
  const [file, setFile] = useState(null);

  const onUpload = async () => {
    if (!file) return notifyError("Select an avatar first");
    try {
      await dispatch(uploadAvatar(file)).unwrap();
      notifySuccess("Avatar uploaded successfully!");
      setFile(null);
    } catch (err) {
      notifyError(err.message || "Upload failed");
    } finally {
      setTimeout(() => dispatch(clearUploadState()), 1200);
    }
  };

  return (
    <div className="max-w-md mx-auto p-4 bg-white rounded shadow">
      <h2 className="text-xl font-bold mb-4">Upload Avatar</h2>
      <FileUpload
        accept="image/*"
        onFilesSelected={setFile}
        label="Choose avatar (max 5MB)"
      />

      {file && (
        <div className="my-2">
          <img
            src={URL.createObjectURL(file)}
            alt="preview"
            className="w-32 h-32 object-cover rounded-full border"
          />
        </div>
      )}

      <button
        onClick={onUpload}
        disabled={loading}
        className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Uploading..." : "Upload Avatar"}
      </button>

      {lastResult && (
        <pre className="bg-gray-100 p-2 mt-4 rounded text-sm overflow-x-auto">
          {JSON.stringify(lastResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
