import React, { useState } from "react";
import FileUpload from "./FileUpload";
import { useDispatch, useSelector } from "react-redux";
import {
  uploadProductImages,
  clearUploadState,
} from "../redux/slices/uplaodSlice";
import { notifyError, notifySuccess } from "../utils/notify";

export default function ProductImageUploadPage() {
  const dispatch = useDispatch();
  const { loading, lastResult } = useSelector((s) => s.upload);
  const [files, setFiles] = useState([]);
  const [productId, setProductId] = useState("");

  const onUpload = async () => {
    if (!productId) return notifyError("Provide product ID");
    if (!files.length) return notifyError("Select images");
    try {
      await dispatch(uploadProductImages({ productId, files })).unwrap();
      notifySuccess("Images uploaded successfully!");
      setFiles([]);
      setProductId("");
    } catch (err) {
      notifyError(err.message || "Upload failed");
    } finally {
      setTimeout(() => dispatch(clearUploadState()), 1200);
    }
  };

  return (
    <div className="max-w-lg mx-auto p-4 bg-white rounded shadow">
      <h2 className="text-xl font-bold mb-4">Upload Product Images</h2>

      <input
        placeholder="Product ID"
        value={productId}
        onChange={(e) => setProductId(e.target.value)}
        className="w-full p-2 mb-4 border rounded"
      />

      <FileUpload
        accept="image/*"
        multiple
        onFilesSelected={setFiles}
        label="Select up to 5 images"
        maxCount={5}
      />

      <div className="flex flex-wrap gap-2 mt-2">
        {files.map((f, i) => (
          <img
            key={i}
            src={URL.createObjectURL(f)}
            alt={f.name}
            className="w-24 h-24 object-cover rounded border"
          />
        ))}
      </div>

      <button
        onClick={onUpload}
        disabled={loading}
        className="mt-4 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? "Uploading..." : "Upload Images"}
      </button>

      {lastResult && (
        <pre className="bg-gray-100 p-2 mt-4 rounded text-sm overflow-x-auto">
          {JSON.stringify(lastResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
