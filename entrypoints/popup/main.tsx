import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App, TAB_STATE_QUERY_KEY } from './App'
import './style.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: false,
    },
  },
})

// Translation state can change behind the popup's back (Alt+A, the content
// script's stopSelfTab). The background records every such change in
// chrome.storage.session as tab_translating_${tabId}, so refetch on that
// write. Module scope, not an effect: the popup page dies when it closes.
// Generic storage.onChanged rather than storage.session.onChanged for
// Firefox; the tab id isn't known here, so any tab_translating_* key counts.
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session') return
  if (!Object.keys(changes).some((key) => key.startsWith('tab_translating_'))) return
  queryClient.invalidateQueries({ queryKey: [TAB_STATE_QUERY_KEY] })
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
