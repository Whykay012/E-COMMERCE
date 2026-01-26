import React from "react";

const FileUpload = ({
  accept,
  multiple = false,
  onFilesSelected,
  label,
  maxCount = 5,
}) => {
  const handleChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (maxCount && files.length > maxCount) files.length = maxCount;
    onFilesSelected(multiple ? files : files[0] || null);
  };

  return (
    <div className="my-4">
      <label className="block font-semibold mb-2">{label}</label>
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        className="block w-full text-gray-700 border rounded p-2 bg-white"
      />
    </div>
  );
};

export default FileUpload;
