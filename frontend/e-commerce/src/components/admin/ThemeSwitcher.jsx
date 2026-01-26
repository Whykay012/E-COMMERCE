export default function ThemeSwitcher({ theme, setTheme }) {
  const themes = [
    { id: "default", label: "Blue" },
    { id: "purple", label: "Purple" },
    { id: "emerald", label: "Emerald" },
  ];

  return (
    <select
      value={theme}
      onChange={(e) => {
        setTheme(e.target.value);
        document.documentElement.setAttribute("data-theme", e.target.value);
        localStorage.setItem("appTheme", e.target.value);
      }}
      className="border rounded-lg px-2 py-1 text-sm dark:bg-gray-700 dark:text-gray-300"
    >
      {themes.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
}
