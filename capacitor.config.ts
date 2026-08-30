import type { CapacitorConfig } from "@capacitor/cli";

const appUrl = "https://restomap.com.tr/";

const config: CapacitorConfig = {
  appId: "com.restomap.app",
  appName: "RESTOMAP",
  webDir: "mobile-web",
  server: {
    url: appUrl,
    cleartext: false,
    androidScheme: "https",
    allowNavigation: [
      "restomap.onrender.com",
      "restomap.com.tr",
      "*.restomap.com.tr",
      "*.google.com",
      "*.google.com.tr",
      "*.googleapis.com",
      "*.gstatic.com",
      "*.googleusercontent.com",
      "*.firebaseio.com",
      "*.firebaseapp.com",
    ],
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1200,
      backgroundColor: "#07110d",
      androidSplashResourceName: "splash",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#07110d",
    },
  },
};

export default config;
