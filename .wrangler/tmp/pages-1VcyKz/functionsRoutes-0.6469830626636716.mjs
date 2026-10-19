import { onRequestGet as __api_state_js_onRequestGet } from "/Users/sergejzatovka/Documents/dish-tracker/functions/api/state.js"
import { onRequestOptions as __api_state_js_onRequestOptions } from "/Users/sergejzatovka/Documents/dish-tracker/functions/api/state.js"
import { onRequestPost as __api_state_js_onRequestPost } from "/Users/sergejzatovka/Documents/dish-tracker/functions/api/state.js"

export const routes = [
    {
      routePath: "/api/state",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_state_js_onRequestGet],
    },
  {
      routePath: "/api/state",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_state_js_onRequestOptions],
    },
  {
      routePath: "/api/state",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_state_js_onRequestPost],
    },
  ]