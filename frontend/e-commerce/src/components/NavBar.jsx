import { useState, useEffect, memo } from "react";
import { Link, NavLink } from "react-router-dom";
import {
  FaShoppingCart,
  FaUserCircle,
  FaBars,
  FaTimes,
  FaSearch,
} from "react-icons/fa";

const Navbar = ({ user, cartItemCount = 0, categories = [] }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrollShadow, setScrollShadow] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Add shadow on scroll
  useEffect(() => {
    const handleScroll = () => setScrollShadow(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const toggleMenu = () => setMenuOpen(!menuOpen);
  const toggleSearch = () => setSearchOpen(!searchOpen);

  return (
    <header
      className={`fixed top-0 w-full z-50 transition-shadow bg-white ${
        scrollShadow ? "shadow-md" : ""
      }`}
    >
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
        {/* Logo */}
        <Link to="/" className="text-2xl font-bold text-blue-600">
          E-Shop
        </Link>

        {/* Desktop Menu */}
        <ul className="hidden md:flex items-center space-x-6">
          <li>
            <NavLink
              to="/"
              className={({ isActive }) =>
                isActive ? "text-blue-600 font-semibold" : "hover:text-blue-500"
              }
            >
              Home
            </NavLink>
          </li>

          {/* Categories Dropdown */}
          <li className="relative group">
            <span className="cursor-pointer hover:text-blue-500 font-semibold">
              Categories
            </span>
            <ul className="absolute left-0 mt-2 w-48 bg-white border rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
              {categories.map((cat) => (
                <li key={cat.id}>
                  <Link
                    to={`/category/${cat.slug}`}
                    className="block px-4 py-2 hover:bg-gray-100"
                  >
                    {cat.name}
                  </Link>
                </li>
              ))}
            </ul>
          </li>

          <li>
            <NavLink
              to="/products"
              className={({ isActive }) =>
                isActive ? "text-blue-600 font-semibold" : "hover:text-blue-500"
              }
            >
              Products
            </NavLink>
          </li>

          <li>
            <NavLink
              to="/cart"
              className="flex items-center relative hover:text-blue-500"
            >
              <FaShoppingCart className="mr-1" />
              Cart
              {cartItemCount > 0 && (
                <span className="absolute -top-2 -right-3 bg-red-600 text-white text-xs font-bold rounded-full px-1.5">
                  {cartItemCount}
                </span>
              )}
            </NavLink>
          </li>

          <li>
            <button
              onClick={toggleSearch}
              aria-label="Search"
              className="hover:text-blue-500 focus:outline-none"
            >
              <FaSearch />
            </button>
          </li>

          {/* User Dropdown */}
          {user ? (
            <li className="relative group">
              <button
                aria-label="User Menu"
                className="flex items-center space-x-1 hover:text-blue-500 focus:outline-none"
              >
                <FaUserCircle className="text-2xl" />
                <span>{user.username}</span>
              </button>
              <ul className="absolute right-0 mt-2 w-48 bg-white border rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
                <li>
                  <Link
                    to="/dashboard"
                    className="block px-4 py-2 hover:bg-gray-100"
                  >
                    Dashboard
                  </Link>
                </li>
                <li>
                  <Link
                    to="/orders"
                    className="block px-4 py-2 hover:bg-gray-100"
                  >
                    Orders
                  </Link>
                </li>
                <li>
                  <Link
                    to="/logout"
                    className="block px-4 py-2 hover:bg-gray-100"
                  >
                    Logout
                  </Link>
                </li>
              </ul>
            </li>
          ) : (
            <>
              <li>
                <Link
                  to="/login"
                  className="px-4 py-1 border rounded-md hover:bg-blue-50"
                >
                  Login
                </Link>
              </li>
              <li>
                <Link
                  to="/register"
                  className="px-4 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Register
                </Link>
              </li>
            </>
          )}
        </ul>

        {/* Mobile Hamburger */}
        <div className="md:hidden flex items-center space-x-3">
          <button
            onClick={toggleSearch}
            aria-label="Search"
            className="hover:text-blue-500 focus:outline-none"
          >
            <FaSearch />
          </button>
          <button
            onClick={toggleMenu}
            aria-label="Toggle menu"
            className="focus:outline-none"
          >
            {menuOpen ? <FaTimes size={24} /> : <FaBars size={24} />}
          </button>
        </div>
      </nav>

      {/* Mobile Search */}
      {searchOpen && (
        <div className="md:hidden bg-white border-b px-4 py-2">
          <input
            type="text"
            placeholder="Search products..."
            className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring focus:border-blue-300"
          />
        </div>
      )}

      {/* Mobile Menu */}
      {menuOpen && (
        <div className="md:hidden bg-white shadow-md border-t border-gray-200 px-4 py-4">
          <ul className="space-y-3">
            <li>
              <NavLink
                to="/"
                onClick={toggleMenu}
                className={({ isActive }) =>
                  isActive
                    ? "text-blue-600 font-semibold"
                    : "hover:text-blue-500"
                }
              >
                Home
              </NavLink>
            </li>

            <li>
              <span className="font-semibold block mb-1">Categories</span>
              <ul className="pl-3 space-y-1">
                {categories.map((cat) => (
                  <li key={cat.id}>
                    <Link
                      to={`/category/${cat.slug}`}
                      onClick={toggleMenu}
                      className="block hover:text-blue-500"
                    >
                      {cat.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>

            <li>
              <NavLink
                to="/products"
                onClick={toggleMenu}
                className={({ isActive }) =>
                  isActive
                    ? "text-blue-600 font-semibold"
                    : "hover:text-blue-500"
                }
              >
                Products
              </NavLink>
            </li>

            <li>
              <NavLink
                to="/cart"
                onClick={toggleMenu}
                className="flex items-center hover:text-blue-500"
              >
                <FaShoppingCart className="mr-1" />
                Cart
                {cartItemCount > 0 && (
                  <span className="ml-1 bg-red-600 text-white text-xs font-bold rounded-full px-1.5">
                    {cartItemCount}
                  </span>
                )}
              </NavLink>
            </li>

            {user ? (
              <>
                <li>
                  <Link
                    to="/dashboard"
                    onClick={toggleMenu}
                    className="block hover:text-blue-500"
                  >
                    Dashboard
                  </Link>
                </li>
                <li>
                  <Link
                    to="/orders"
                    onClick={toggleMenu}
                    className="block hover:text-blue-500"
                  >
                    Orders
                  </Link>
                </li>
                <li>
                  <Link
                    to="/logout"
                    onClick={toggleMenu}
                    className="block hover:text-blue-500"
                  >
                    Logout
                  </Link>
                </li>
              </>
            ) : (
              <>
                <li>
                  <Link
                    to="/login"
                    onClick={toggleMenu}
                    className="block hover:text-blue-500"
                  >
                    Login
                  </Link>
                </li>
                <li>
                  <Link
                    to="/register"
                    onClick={toggleMenu}
                    className="block bg-blue-600 text-white text-center rounded-md py-1 hover:bg-blue-700"
                  >
                    Register
                  </Link>
                </li>
              </>
            )}
          </ul>
        </div>
      )}
    </header>
  );
};

export default memo(Navbar);
