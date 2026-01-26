import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../../utils/api";

// ================================
// 🔹 Async Thunks (API Calls)
// ================================

// 🧭 Fetch all products (pagination, search, filters, or random)
export const fetchProducts = createAsyncThunk(
  "product/fetchProducts",
  async (
    {
      page = 1,
      limit = 20,
      search = "",
      category = "",
      subCategory = "",
      random = false,
    } = {},
    { rejectWithValue }
  ) => {
    try {
      const url = random
        ? `/products/random?size=${limit}`
        : `/products?page=${page}&limit=${limit}&search=${search}&category=${category}&subCategory=${subCategory}`;
      const res = await api.get(url);
      return res.data; // { products, total, page, limit }
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to fetch products"
      );
    }
  }
);

// 🧩 Fetch single product by ID
export const fetchProductById = createAsyncThunk(
  "product/fetchProductById",
  async (id, { rejectWithValue }) => {
    try {
      const res = await api.get(`/products/${id}`);
      return res.data; // { product, related }
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to fetch product"
      );
    }
  }
);

// ➕ Add new product
export const addProduct = createAsyncThunk(
  "product/addProduct",
  async (productData, { rejectWithValue }) => {
    try {
      const res = await api.post("/products", productData);
      return res.data.product;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to add product"
      );
    }
  }
);

// ✏️ Update product
export const updateProduct = createAsyncThunk(
  "product/updateProduct",
  async ({ id, updates }, { rejectWithValue }) => {
    try {
      const res = await api.put(`/products/${id}`, updates);
      return res.data.product;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to update product"
      );
    }
  }
);

// 🗑️ Delete product
export const deleteProduct = createAsyncThunk(
  "product/deleteProduct",
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/products/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message || "Failed to delete product"
      );
    }
  }
);

// ================================
// ⚙️ Slice Definition
// ================================
const productSlice = createSlice({
  name: "product",
  initialState: {
    products: [],
    product: null,
    related: [],
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 1,
    loading: false,
    error: null,
    success: false,
  },
  reducers: {
    clearProduct: (state) => {
      state.product = null;
      state.related = [];
      state.error = null;
      state.success = false;
    },
    clearError: (state) => {
      state.error = null;
    },
    clearSuccess: (state) => {
      state.success = false;
    },
  },
  extraReducers: (builder) => {
    builder
      // 🧭 FETCH ALL PRODUCTS
      .addCase(fetchProducts.pending, (state) => {
        state.loading = true;
        state.error = null;
        state.success = false;
      })
      .addCase(fetchProducts.fulfilled, (state, action) => {
        state.loading = false;
        state.products = action.payload.products || [];
        state.total = action.payload.total || state.products.length;
        state.page = action.payload.page || 1;
        state.limit = action.payload.limit || 20;
        state.totalPages = Math.ceil(state.total / state.limit);
        state.success = true;
      })
      .addCase(fetchProducts.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // 🧩 FETCH SINGLE PRODUCT
      .addCase(fetchProductById.pending, (state) => {
        state.loading = true;
        state.product = null;
        state.related = [];
      })
      .addCase(fetchProductById.fulfilled, (state, action) => {
        state.loading = false;
        state.product = action.payload.product;
        state.related = action.payload.related || [];
        state.success = true;
      })
      .addCase(fetchProductById.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // ➕ ADD PRODUCT
      .addCase(addProduct.pending, (state) => {
        state.loading = true;
        state.success = false;
      })
      .addCase(addProduct.fulfilled, (state, action) => {
        state.loading = false;
        state.success = true;
        state.products.unshift(action.payload);
      })
      .addCase(addProduct.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // ✏️ UPDATE PRODUCT
      .addCase(updateProduct.fulfilled, (state, action) => {
        state.loading = false;
        state.success = true;
        state.products = state.products.map((p) =>
          p._id === action.payload._id ? action.payload : p
        );
      })
      .addCase(updateProduct.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

      // 🗑️ DELETE PRODUCT
      .addCase(deleteProduct.fulfilled, (state, action) => {
        state.loading = false;
        state.products = state.products.filter((p) => p._id !== action.payload);
      })
      .addCase(deleteProduct.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  },
});

export const { clearProduct, clearError, clearSuccess } = productSlice.actions;
export default productSlice.reducer;
