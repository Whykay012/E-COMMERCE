import React, { useState } from "react";
import FileUpload from "./FileUpload";
import { useDispatch, useSelector } from "react-redux";
import { uploadBanner, clearUploadState } from "../redux/slices/uplaodSlice";
import { notifyError, notifySuccess } from "../utils/notify";

export default function BannerUploadPage() {
  const dispatch = useDispatch();
  const { loading, lastResult } = useSelector((s) => s.upload);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [active, setActive] = useState(true);

  const onUpload = async () => {
    if (!file) return notifyError("Select a banner");
    try {
      await dispatch(uploadBanner({ title, file, active })).unwrap();
      notifySuccess("Banner uploaded successfully!");
      setFile(null);
      setTitle("");
    } catch (err) {
      notifyError(err.message || "Upload failed");
    } finally {
      setTimeout(() => dispatch(clearUploadState()), 1200);
    }
  };

  return (
    <div className="max-w-md mx-auto p-4 bg-white rounded shadow">
      <h2 className="text-xl font-bold mb-4">Upload Banner</h2>

      <input
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full p-2 mb-4 border rounded"
      />

      <div className="mb-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="form-checkbox"
          />
          Active
        </label>
      </div>

      <FileUpload
        accept="image/*"
        multiple={false}
        onFilesSelected={setFile}
        label="Choose banner (max 10MB)"
      />

      {file && (
        <img
          src={URL.createObjectURL(file)}
          alt="banner preview"
          className="w-full h-40 object-cover rounded mt-2"
        />
      )}

      <button
        onClick={onUpload}
        disabled={loading}
        className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
      >
        {loading ? "Uploading..." : "Upload Banner"}
      </button>

      {lastResult && (
        <pre className="bg-gray-100 p-2 mt-4 rounded text-sm overflow-x-auto">
          {JSON.stringify(lastResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
