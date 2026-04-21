# BulkPro - WhatsApp Bulk Messaging Dashboard 🚀

<p align="center">
  <img src="banner.png" alt="BulkPro Banner" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4.0-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" />
  <img src="https://img.shields.io/badge/Status-Active-25D366?style=for-the-badge" />
</p>

**BulkPro** is a professional-grade, full-stack WhatsApp automation dashboard. It empowers businesses and developers to manage bulk messaging campaigns through a sleek, modern UI, leveraging the power of `whatsapp-web.js` and a real Chrome browser engine for maximum reliability.

---

## ✨ Features

- 📱 **QR Authentication:** Easy login via standard WhatsApp QR scanning.
- 📤 **Bulk Broadcasting:** Send text, high-res images, videos, and documents.
- 📊 **Spreadsheet Integration:** Import thousands of contacts instantly from `.xlsx` or `.csv` files.
- 🛡️ **Anti-Ban Protection:** Smart, randomized cooling-down delays between messages to mimic human behavior.
- 👁️ **Live WhatsApp Preview:** Real-time visualization of how your message will look on a recipient's phone.
- 🚦 **Campaign Controls:** Pause, Resume, or Stop your broadcast campaigns at any moment.
- 🌗 **Premium Dark UI:** Stunning dashboard built with **Tailwind CSS 4** and **Framer Motion**.

---

## 🛠️ Tech Stack

**Frontend:**
- **React 19:** Next-gen reactive UI.
- **Tailwind CSS 4:** Modern utility-first styling.
- **Framer Motion:** High-fidelity animations.
- **Socket.io-client:** Real-time data synchronization.

**Backend:**
- **Node.js & Express:** Scalable server architecture.
- **WhatsApp-Web.js:** Professional WhatsApp Web API wrapper.
- **Puppeteer:** Headless Chrome engine for reliable interaction.
- **Socket.io:** Bidirectional log and status streaming.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Installation

1. **Clone the project:**
   ```bash
   git clone https://github.com/kunaldevelopers/whatsapp-bulk-sender-dashboard.git
   cd whatsapp-bulk-sender-dashboard
   ```

2. **Install Root Dependencies:**
   ```bash
   npm install
   ```

3. **Install Client & Server Dependencies:**
   ```bash
   npm run install-all
   ```

4. **Install Chromium for Puppeteer:**
   ```bash
   cd server
   npx puppeteer browsers install chrome
   ```

### Running the App

Run the following command in the root directory to start both the Frontend and Backend concurrently:

```bash
npm start
```

- **Dashboard UI:** [http://localhost:5173](http://localhost:5173)
- **Backend API:** [http://localhost:8790](http://localhost:8790)

---

## 📁 Project Structure

```text
├── client/                # React Frontend (Vite)
│   ├── src/
│   │   ├── App.jsx        # Main Dashboard Logic & UI
│   │   └── index.css      # Styling & Design System
├── server/                # Node.js Backend
│   ├── index.js           # Core Automation Logic
│   └── .wwebjs_auth/      # Encrypted Session Data (Ignored by Git)
├── package.json           # Root scripts
└── banner.png             # Visual Assets
```

---

## ⚠️ Disclaimer
This tool is intended for personal or educational use. Bulk messaging can lead to account bans if misused. Always follow WhatsApp's Terms of Service and use the built-in "Delay" features responsibly.

---

## 🤝 Contributing
Contributions are welcome! If you have ideas for new features or encounter bugs, please open an issue or submit a pull request.

---

## 📄 License
This project is licensed under the MIT License - see the LICENSE file for details.

---

<p align="center">
  Crafted with ❤️ by <strong>Kunal Developer</strong>
</p>
