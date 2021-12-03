import * as React from "react";
import type { AppProps } from "next/app";
import { createTheme, ThemeProvider } from "@mui/material/styles";

import "../styles/globals.css";

function MyApp({ Component, pageProps }: AppProps) {
    const theme = React.useMemo(() => createTheme({ palette: { mode: "dark" } }), []);

    return (
        <ThemeProvider theme={theme}>
            <Component {...pageProps} />
        </ThemeProvider>
    );
}

export default MyApp;
