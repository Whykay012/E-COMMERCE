import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  search: "",
  category: "",
  sort: "latest",
};

const querySlice = createSlice({
  name: "query",
  initialState,
  reducers: {
    setSearch: (state, action) => {
      state.search = action.payload;
    },
    setCategory: (state, action) => {
      state.category = action.payload;
    },
    setSort: (state, action) => {
      state.sort = action.payload;
    },
    resetQuery: (state) => {
      state.search = "";
      state.category = "";
      state.sort = "latest";
    },
  },
});

export const { setSearch, setCategory, setSort, resetQuery } =
  querySlice.actions;
export default querySlice.reducer;
