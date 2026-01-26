import React, { useState } from "react";
import FileUpload from "./FileUpload";
import { useDispatch, useSelector } from "react-redux";
import {
  uploadProductVideo,
  clearUploadState,
} from "../redux/slices/uplaodSlice";
import { notifyError, notifySuccess } from "../utils/notify";

export default function ProductVideoUploadPage() {
  const dispatch = useDispatch();
  const { loading, lastResult } = useSelector((s) => s.upload);
  const [file, setFile] = useState(null);
  const [productId, setProductId] = useState("");

  const onUpload = async () => {
    if (!productId) return notifyError("Provide product ID");
    if (!file) return notifyError("Select a video");
    try {
      await dispatch(uploadProductVideo({ productId, file })).unwrap();
      notifySuccess("Video uploaded successfully!");
      setFile(null);
      setProductId("");
    } catch (err) {
      notifyError(err.message || "Upload failed");
    } finally {
      setTimeout(() => dispatch(clearUploadState()), 1200);
    }
  };

  return (
    <div className="max-w-lg mx-auto p-4 bg-white rounded shadow">
      <h2 className="text-xl font-bold mb-4">Upload Product Video</h2>

      <input
        placeholder="Product ID"
        value={productId}
        onChange={(e) => setProductId(e.target.value)}
        className="w-full p-2 mb-4 border rounded"
      />

      <FileUpload
        accept="video/*"
        multiple={false}
        onFilesSelected={setFile}
        label="Select video (max 50MB)"
      />

      {file && (
        <video
          width="100%"
          className="mt-2 rounded border"
          controls
          src={URL.createObjectURL(file)}
        />
      )}

      <button
        onClick={onUpload}
        disabled={loading}
        className="mt-4 px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
      >
        {loading ? "Uploading..." : "Upload Video"}
      </button>

      {lastResult && (
        <pre className="bg-gray-100 p-2 mt-4 rounded text-sm overflow-x-auto">
          {JSON.stringify(lastResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
