const translations = {
  'en': {
    appTitle: 'Serial Terminal',
    prefsTitle: 'Preferences',
    common: {
      none: 'None',
      loading: 'Loading...',
      noHistory: 'No history',
      emptyContent: 'Empty content'
    },
    main: {
      selectPort: 'Select Port',
      selectSerialPort: 'Select Serial Port',
      refreshPorts: 'Refresh Ports',
      baudRate: 'Baud Rate',
      customBaudRate: 'Baud Rate',
      backToList: 'Back to list',
      connect: 'Connect',
      disconnect: 'Disconnect',
      clearLog: 'Clear Log',
      clearTerminalOutput: 'Clear Terminal Output',
      disconnected: 'Disconnected',
      connected: 'Connected',
      settingsTab: 'Settings',
      searchTab: 'Search',
      sendTab: 'Send',
      dataBits8: 'Data Bits: 8',
      dataBits7: 'Data Bits: 7',
      dataBits6: 'Data Bits: 6',
      dataBits5: 'Data Bits: 5',
      stopBits1: 'Stop Bits: 1',
      stopBits15: 'Stop Bits: 1.5',
      stopBits2: 'Stop Bits: 2',
      parityNone: 'Parity: None',
      parityEven: 'Parity: Even',
      parityOdd: 'Parity: Odd',
      parityMark: 'Parity: Mark',
      paritySpace: 'Parity: Space',
      encodingUtf8: 'Enc: UTF-8',
      encodingAscii: 'Enc: ASCII',
      encodingHex: 'Enc: Hex',
      encodingGbk: 'Enc: GBK',
      newlineCrlf: 'NL: CRLF / CRLF',
      newlineLf: 'NL: LF / LF',
      newlineCr: 'NL: CR / CR',
      showTime: 'Show Time',
      showLineNo: 'Show Line #',
      searchPlaceholder: 'Search...',
      prev: 'Prev',
      next: 'Next',
      regex: 'Regex',
      caseSensitive: 'Case Sensitive',
      wholeWord: 'Whole Word',
      autoSend: 'Auto Send',
      autoSendText: 'Text to auto send...',
      quickSendList: 'Quick Send List',
      label: 'Label',
      contentMultiLine: 'Content (multi-line)',
      addToList: '+ Add to List',
      globalSettings: 'Settings',
      toggleInput: 'Input',
      toggleInputShow: 'Show input panel',
      toggleInputHide: 'Hide input panel',
      mainTerminal: 'Main Terminal',
      newFilterTab: 'New Filter Tab',
      filter: 'Filter',
      closeTab: 'Close Tab',
      filterText: 'Filter text...',
      matchCase: 'Match Case',
      useRegex: 'Use Regular Expression',
      sendInputPlaceholder: 'Type data to send...',
      send: 'Send',
      autoSendToggle: 'Auto Send',
      shortcutSendToggle: 'Shortcut Send',
      lastSentNone: 'Last sent: None',
      lastSent: 'Last sent: {value}',
      connectedTo: '--- Connected to {path} at {baudRate} baud ({dataBits}N{stopBits}) ---',
      failedToConnect: 'Failed to connect: {error}',
      serialDisconnected: 'Serial port disconnected',
      errorPrefix: '[ERROR] {error}',
      rx: 'RX',
      tx: 'TX'
    },
    prefs: {
      appearance: 'Appearance',
      terminal: 'Terminal',
      highlighting: 'Highlighting',
      logging: 'Logging',
      about: 'About',
      appearanceSettings: 'Appearance Settings',
      language: 'Language',
      englishFontFamily: 'English Font Family',
      chineseFallbackFontFamily: 'Chinese/Fallback Font Family',
      fontSize: 'Font Size (px)',
      textColor: 'Text Color',
      backgroundColor: 'Background Color',
      timestampColor: 'Timestamp Color',
      lineNumberColor: 'Line Number Color',
      terminalSettings: 'Terminal Settings',
      scrollbackLimit: 'Scrollback Limit (lines)',
      scrollbackHelp: 'Maximum number of lines to keep in the terminal buffer. Higher values use more memory.',
      historyBufferSize: 'History Buffer Size (characters)',
      historyBufferHelp: 'Size of the history buffer for new windows (in characters). Approx 1MB = 1,000,000 chars.',
      keywordHighlighting: 'Keyword Highlighting',
      addRule: '+ Add New Rule',
      enableDisable: 'Enable/Disable',
      regexPlaceholder: 'Regex (e.g. error)',
      removeRule: 'Remove Rule',
      loggingSettings: 'Logging Settings',
      enableAutomaticLogging: 'Enable Automatic Logging',
      logSavePath: 'Log Save Path',
      browse: 'Browse...',
      fileNameFormat: 'File Name Format',
      fileNamePlaceholder: 'log_%Y-%m-%d_%H-%M-%S.txt',
      supportedTags: 'Supported tags: %Y, %m, %d, %H, %M, %S',
      textEncoding: 'Text Encoding',
      aboutSerialTerminal: 'About SerialTerminal',
      version: 'Version',
      author: 'Author',
      github: 'GitHub',
      softwareUpdate: 'Software Update',
      currentVersionUpToDate: 'Current version is up to date.',
      checkForUpdates: 'Check for Updates',
      restartInstall: 'Restart & Install',
      resetDefaults: 'Reset Defaults',
      openConfigFolder: 'Open Config Folder',
      cancel: 'Cancel',
      saveApply: 'Save & Apply',
      systemFonts: 'System Fonts',
      confirmReset: 'Are you sure you want to reset all settings to defaults? This cannot be undone.',
      checkingForUpdates: 'Checking for updates...',
      updateAvailable: 'Update available: {version}. Downloading...',
      latestVersion: 'You are on the latest version.',
      updateFailedNetwork: 'Update failed (Network Error).',
      downloadFromGithub: 'Download manually from GitHub',
      error: 'Error: {message}',
      downloading: 'Downloading... {percent}%',
      updateDownloaded: 'Update downloaded ({version}). Ready to install.'
    },
    languages: {
      en: 'English',
      zhCN: '简体中文',
      zhTW: '繁體中文',
      fr: 'Français',
      ru: 'Русский',
      de: 'Deutsch'
    }
  },
  'zh-CN': {
    appTitle: '串口终端',
    prefsTitle: '设置',
    common: {
      none: '暂无',
      loading: '加载中...',
      noHistory: '暂无历史',
      emptyContent: '空内容'
    },
    main: {
      selectPort: '选择串口', selectSerialPort: '选择串口', refreshPorts: '刷新串口', baudRate: '波特率', customBaudRate: '波特率', backToList: '返回列表', connect: '连接', disconnect: '断开', clearLog: '清空日志', clearTerminalOutput: '清空终端输出', disconnected: '未连接', connected: '已连接', settingsTab: '设置', searchTab: '搜索', sendTab: '发送', dataBits8: '数据位: 8', dataBits7: '数据位: 7', dataBits6: '数据位: 6', dataBits5: '数据位: 5', stopBits1: '停止位: 1', stopBits15: '停止位: 1.5', stopBits2: '停止位: 2', parityNone: '校验: 无', parityEven: '校验: 偶', parityOdd: '校验: 奇', parityMark: '校验: Mark', paritySpace: '校验: Space', encodingUtf8: '编码: UTF-8', encodingAscii: '编码: ASCII', encodingHex: '编码: Hex', encodingGbk: '编码: GBK', newlineCrlf: '换行: CRLF / CRLF', newlineLf: '换行: LF / LF', newlineCr: '换行: CR / CR', showTime: '显示时间', showLineNo: '显示行号', searchPlaceholder: '搜索...', prev: '上一个', next: '下一个', regex: '正则', caseSensitive: '区分大小写', wholeWord: '整词匹配', autoSend: '自动发送', autoSendText: '自动发送文本...', quickSendList: '快捷发送列表', label: '标签', contentMultiLine: '内容（多行）', addToList: '+ 添加到列表', globalSettings: '设置', toggleInput: '输入框', toggleInputShow: '显示输入框', toggleInputHide: '隐藏输入框', mainTerminal: '主终端', newFilterTab: '新建过滤标签页', filter: '过滤', closeTab: '关闭标签页', filterText: '过滤文本...', matchCase: '区分大小写', useRegex: '使用正则表达式', sendInputPlaceholder: '输入要发送的内容...', send: '发送', autoSendToggle: '自动发送', shortcutSendToggle: '快捷键发送', lastSentNone: '上一条发送：暂无', lastSent: '上一条发送：{value}', connectedTo: '--- 已连接到 {path}，波特率 {baudRate} ({dataBits}N{stopBits}) ---', failedToConnect: '连接失败：{error}', serialDisconnected: '串口已断开', errorPrefix: '[错误] {error}', rx: '接收', tx: '发送'
    },
    prefs: {
      appearance: '外观', terminal: '终端', highlighting: '高亮', logging: '日志', about: '关于', appearanceSettings: '外观设置', language: '语言', englishFontFamily: '英文字体', chineseFallbackFontFamily: '中文/后备字体', fontSize: '字体大小 (px)', textColor: '文字颜色', backgroundColor: '背景颜色', timestampColor: '时间戳颜色', lineNumberColor: '行号颜色', terminalSettings: '终端设置', scrollbackLimit: '回滚行数限制', scrollbackHelp: '终端缓冲区保留的最大行数。值越大占用内存越多。', historyBufferSize: '历史缓冲区大小（字符）', historyBufferHelp: '新窗口的历史缓冲区大小（字符）。约 1MB = 1,000,000 字符。', keywordHighlighting: '关键字高亮', addRule: '+ 添加新规则', enableDisable: '启用/禁用', regexPlaceholder: '正则（例如 error）', removeRule: '删除规则', loggingSettings: '日志设置', enableAutomaticLogging: '启用自动日志', logSavePath: '日志保存路径', browse: '浏览...', fileNameFormat: '文件名格式', fileNamePlaceholder: 'log_%Y-%m-%d_%H-%M-%S.txt', supportedTags: '支持标签：%Y, %m, %d, %H, %M, %S', textEncoding: '文本编码', aboutSerialTerminal: '关于 SerialTerminal', version: '版本', author: '作者', github: 'GitHub', softwareUpdate: '软件更新', currentVersionUpToDate: '当前版本已是最新。', checkForUpdates: '检查更新', restartInstall: '重启并安装', resetDefaults: '恢复默认', openConfigFolder: '打开配置目录', cancel: '取消', saveApply: '保存并应用', systemFonts: '系统字体', confirmReset: '确定要恢复所有默认设置吗？此操作无法撤销。', checkingForUpdates: '正在检查更新...', updateAvailable: '发现新版本：{version}，正在下载...', latestVersion: '当前已是最新版本。', updateFailedNetwork: '更新失败（网络错误）。', downloadFromGithub: '前往 GitHub 手动下载', error: '错误：{message}', downloading: '正在下载... {percent}%', updateDownloaded: '更新已下载（{version}），可立即安装。'
    },
    languages: { en: 'English', zhCN: '简体中文', zhTW: '繁體中文', fr: 'Français', ru: 'Русский', de: 'Deutsch' }
  },
  'zh-TW': {
    appTitle: '串口終端', prefsTitle: '設定', common: { none: '暫無', loading: '載入中...', noHistory: '暫無歷史', emptyContent: '空內容' },
    main: { selectPort: '選擇串口', selectSerialPort: '選擇串口', refreshPorts: '重新整理串口', baudRate: '鮑率', customBaudRate: '鮑率', backToList: '返回列表', connect: '連接', disconnect: '中斷連接', clearLog: '清空日誌', clearTerminalOutput: '清空終端輸出', disconnected: '未連接', connected: '已連接', settingsTab: '設定', searchTab: '搜尋', sendTab: '發送', dataBits8: '資料位: 8', dataBits7: '資料位: 7', dataBits6: '資料位: 6', dataBits5: '資料位: 5', stopBits1: '停止位: 1', stopBits15: '停止位: 1.5', stopBits2: '停止位: 2', parityNone: '校驗: 無', parityEven: '校驗: 偶', parityOdd: '校驗: 奇', parityMark: '校驗: Mark', paritySpace: '校驗: Space', encodingUtf8: '編碼: UTF-8', encodingAscii: '編碼: ASCII', encodingHex: '編碼: Hex', encodingGbk: '編碼: GBK', newlineCrlf: '換行: CRLF / CRLF', newlineLf: '換行: LF / LF', newlineCr: '換行: CR / CR', showTime: '顯示時間', showLineNo: '顯示行號', searchPlaceholder: '搜尋...', prev: '上一個', next: '下一個', regex: '正則', caseSensitive: '區分大小寫', wholeWord: '整詞匹配', autoSend: '自動發送', autoSendText: '自動發送文字...', quickSendList: '快速發送列表', label: '標籤', contentMultiLine: '內容（多行）', addToList: '+ 加入列表', globalSettings: '設定', toggleInput: '輸入框', toggleInputShow: '顯示輸入框', toggleInputHide: '隱藏輸入框', mainTerminal: '主終端', newFilterTab: '新增過濾分頁', filter: '過濾', closeTab: '關閉分頁', filterText: '過濾文字...', matchCase: '區分大小寫', useRegex: '使用正則表達式', sendInputPlaceholder: '輸入要發送的內容...', send: '發送', autoSendToggle: '自動發送', shortcutSendToggle: '快捷鍵發送', lastSentNone: '上一條發送：暫無', lastSent: '上一條發送：{value}', connectedTo: '--- 已連接到 {path}，鮑率 {baudRate} ({dataBits}N{stopBits}) ---', failedToConnect: '連接失敗：{error}', serialDisconnected: '串口已中斷', errorPrefix: '[錯誤] {error}', rx: '接收', tx: '發送' },
    prefs: { appearance: '外觀', terminal: '終端', highlighting: '高亮', logging: '日誌', about: '關於', appearanceSettings: '外觀設定', language: '語言', englishFontFamily: '英文字型', chineseFallbackFontFamily: '中文/後備字型', fontSize: '字型大小 (px)', textColor: '文字顏色', backgroundColor: '背景顏色', timestampColor: '時間戳顏色', lineNumberColor: '行號顏色', terminalSettings: '終端設定', scrollbackLimit: '回滾行數限制', scrollbackHelp: '終端緩衝區保留的最大行數。值越大占用記憶體越多。', historyBufferSize: '歷史緩衝區大小（字元）', historyBufferHelp: '新視窗的歷史緩衝區大小（字元）。約 1MB = 1,000,000 字元。', keywordHighlighting: '關鍵字高亮', addRule: '+ 新增規則', enableDisable: '啟用/停用', regexPlaceholder: '正則（例如 error）', removeRule: '刪除規則', loggingSettings: '日誌設定', enableAutomaticLogging: '啟用自動日誌', logSavePath: '日誌儲存路徑', browse: '瀏覽...', fileNameFormat: '檔名格式', fileNamePlaceholder: 'log_%Y-%m-%d_%H-%M-%S.txt', supportedTags: '支援標籤：%Y, %m, %d, %H, %M, %S', textEncoding: '文字編碼', aboutSerialTerminal: '關於 SerialTerminal', version: '版本', author: '作者', github: 'GitHub', softwareUpdate: '軟體更新', currentVersionUpToDate: '目前版本已是最新。', checkForUpdates: '檢查更新', restartInstall: '重新啟動並安裝', resetDefaults: '恢復預設', openConfigFolder: '開啟設定資料夾', cancel: '取消', saveApply: '儲存並套用', systemFonts: '系統字型', confirmReset: '確定要恢復所有預設設定嗎？此操作無法復原。', checkingForUpdates: '正在檢查更新...', updateAvailable: '發現新版本：{version}，正在下載...', latestVersion: '目前已是最新版本。', updateFailedNetwork: '更新失敗（網路錯誤）。', downloadFromGithub: '前往 GitHub 手動下載', error: '錯誤：{message}', downloading: '正在下載... {percent}%', updateDownloaded: '更新已下載（{version}），可立即安裝。' },
    languages: { en: 'English', zhCN: '简体中文', zhTW: '繁體中文', fr: 'Français', ru: 'Русский', de: 'Deutsch' }
  },
  'fr': {
    appTitle: 'Terminal Série', prefsTitle: 'Préférences', common: { none: 'Aucun', loading: 'Chargement...', noHistory: 'Aucun historique', emptyContent: 'Contenu vide' },
    main: { selectPort: 'Sélectionner le port', selectSerialPort: 'Sélectionner le port série', refreshPorts: 'Actualiser les ports', baudRate: 'Débit en bauds', customBaudRate: 'Débit en bauds', backToList: 'Retour à la liste', connect: 'Connecter', disconnect: 'Déconnecter', clearLog: 'Effacer le journal', clearTerminalOutput: 'Effacer la sortie du terminal', disconnected: 'Déconnecté', connected: 'Connecté', settingsTab: 'Réglages', searchTab: 'Recherche', sendTab: 'Envoi', dataBits8: 'Bits de données : 8', dataBits7: 'Bits de données : 7', dataBits6: 'Bits de données : 6', dataBits5: 'Bits de données : 5', stopBits1: 'Bits d’arrêt : 1', stopBits15: 'Bits d’arrêt : 1,5', stopBits2: 'Bits d’arrêt : 2', parityNone: 'Parité : Aucune', parityEven: 'Parité : Paire', parityOdd: 'Parité : Impaire', parityMark: 'Parité : Mark', paritySpace: 'Parité : Space', encodingUtf8: 'Encodage : UTF-8', encodingAscii: 'Encodage : ASCII', encodingHex: 'Encodage : Hex', encodingGbk: 'Encodage : GBK', newlineCrlf: 'Fin de ligne : CRLF / CRLF', newlineLf: 'Fin de ligne : LF / LF', newlineCr: 'Fin de ligne : CR / CR', showTime: 'Afficher l’heure', showLineNo: 'Afficher le n° de ligne', searchPlaceholder: 'Rechercher...', prev: 'Préc.', next: 'Suiv.', regex: 'Regex', caseSensitive: 'Respecter la casse', wholeWord: 'Mot entier', autoSend: 'Envoi auto', autoSendText: 'Texte à envoyer automatiquement...', quickSendList: 'Liste d’envoi rapide', label: 'Étiquette', contentMultiLine: 'Contenu (multiligne)', addToList: '+ Ajouter à la liste', globalSettings: 'Réglages', toggleInput: 'Saisie', toggleInputShow: 'Afficher la zone de saisie', toggleInputHide: 'Masquer la zone de saisie', mainTerminal: 'Terminal principal', newFilterTab: 'Nouvel onglet de filtre', filter: 'Filtre', closeTab: 'Fermer l’onglet', filterText: 'Texte du filtre...', matchCase: 'Respecter la casse', useRegex: 'Utiliser une expression régulière', sendInputPlaceholder: 'Saisir les données à envoyer...', send: 'Envoyer', autoSendToggle: 'Envoi auto', shortcutSendToggle: 'Envoi clavier', lastSentNone: 'Dernier envoi : Aucun', lastSent: 'Dernier envoi : {value}', connectedTo: '--- Connecté à {path} à {baudRate} bauds ({dataBits}N{stopBits}) ---', failedToConnect: 'Échec de connexion : {error}', serialDisconnected: 'Port série déconnecté', errorPrefix: '[ERREUR] {error}', rx: 'RX', tx: 'TX' },
    prefs: { appearance: 'Apparence', terminal: 'Terminal', highlighting: 'Surlignage', logging: 'Journalisation', about: 'À propos', appearanceSettings: 'Paramètres d’apparence', language: 'Langue', englishFontFamily: 'Police anglaise', chineseFallbackFontFamily: 'Police chinoise/de secours', fontSize: 'Taille de police (px)', textColor: 'Couleur du texte', backgroundColor: 'Couleur d’arrière-plan', timestampColor: 'Couleur de l’horodatage', lineNumberColor: 'Couleur du numéro de ligne', terminalSettings: 'Paramètres du terminal', scrollbackLimit: 'Limite de défilement (lignes)', scrollbackHelp: 'Nombre maximal de lignes conservées dans le tampon du terminal. Une valeur plus élevée consomme plus de mémoire.', historyBufferSize: 'Taille du tampon d’historique (caractères)', historyBufferHelp: 'Taille du tampon d’historique pour les nouvelles fenêtres (en caractères). Environ 1 Mo = 1 000 000 caractères.', keywordHighlighting: 'Surlignage des mots-clés', addRule: '+ Ajouter une règle', enableDisable: 'Activer/Désactiver', regexPlaceholder: 'Regex (ex. error)', removeRule: 'Supprimer la règle', loggingSettings: 'Paramètres de journalisation', enableAutomaticLogging: 'Activer la journalisation automatique', logSavePath: 'Chemin d’enregistrement du journal', browse: 'Parcourir...', fileNameFormat: 'Format du nom de fichier', fileNamePlaceholder: 'log_%Y-%m-%d_%H-%M-%S.txt', supportedTags: 'Balises prises en charge : %Y, %m, %d, %H, %M, %S', textEncoding: 'Encodage du texte', aboutSerialTerminal: 'À propos de SerialTerminal', version: 'Version', author: 'Auteur', github: 'GitHub', softwareUpdate: 'Mise à jour logicielle', currentVersionUpToDate: 'La version actuelle est à jour.', checkForUpdates: 'Vérifier les mises à jour', restartInstall: 'Redémarrer et installer', resetDefaults: 'Réinitialiser', openConfigFolder: 'Ouvrir le dossier de configuration', cancel: 'Annuler', saveApply: 'Enregistrer et appliquer', systemFonts: 'Polices système', confirmReset: 'Voulez-vous vraiment réinitialiser tous les paramètres ? Cette action est irréversible.', checkingForUpdates: 'Vérification des mises à jour...', updateAvailable: 'Mise à jour disponible : {version}. Téléchargement...', latestVersion: 'Vous disposez déjà de la dernière version.', updateFailedNetwork: 'Échec de la mise à jour (erreur réseau).', downloadFromGithub: 'Télécharger manuellement depuis GitHub', error: 'Erreur : {message}', downloading: 'Téléchargement... {percent}%', updateDownloaded: 'Mise à jour téléchargée ({version}). Prête à être installée.' },
    languages: { en: 'English', zhCN: '简体中文', zhTW: '繁體中文', fr: 'Français', ru: 'Русский', de: 'Deutsch' }
  },
  'ru': {
    appTitle: 'Последовательный терминал', prefsTitle: 'Настройки', common: { none: 'Нет', loading: 'Загрузка...', noHistory: 'История пуста', emptyContent: 'Пусто' },
    main: { selectPort: 'Выбрать порт', selectSerialPort: 'Выбрать последовательный порт', refreshPorts: 'Обновить порты', baudRate: 'Скорость', customBaudRate: 'Скорость', backToList: 'Назад к списку', connect: 'Подключить', disconnect: 'Отключить', clearLog: 'Очистить журнал', clearTerminalOutput: 'Очистить терминал', disconnected: 'Отключено', connected: 'Подключено', settingsTab: 'Настройки', searchTab: 'Поиск', sendTab: 'Отправка', dataBits8: 'Биты данных: 8', dataBits7: 'Биты данных: 7', dataBits6: 'Биты данных: 6', dataBits5: 'Биты данных: 5', stopBits1: 'Стоп-биты: 1', stopBits15: 'Стоп-биты: 1.5', stopBits2: 'Стоп-биты: 2', parityNone: 'Чётность: Нет', parityEven: 'Чётность: Чётная', parityOdd: 'Чётность: Нечётная', parityMark: 'Чётность: Mark', paritySpace: 'Чётность: Space', encodingUtf8: 'Кодировка: UTF-8', encodingAscii: 'Кодировка: ASCII', encodingHex: 'Кодировка: Hex', encodingGbk: 'Кодировка: GBK', newlineCrlf: 'Новая строка: CRLF / CRLF', newlineLf: 'Новая строка: LF / LF', newlineCr: 'Новая строка: CR / CR', showTime: 'Показывать время', showLineNo: 'Показывать № строки', searchPlaceholder: 'Поиск...', prev: 'Назад', next: 'Вперёд', regex: 'Regex', caseSensitive: 'Учитывать регистр', wholeWord: 'Только слово', autoSend: 'Автоотправка', autoSendText: 'Текст для автоотправки...', quickSendList: 'Быстрая отправка', label: 'Метка', contentMultiLine: 'Содержимое (много строк)', addToList: '+ Добавить в список', globalSettings: 'Настройки', toggleInput: 'Ввод', toggleInputShow: 'Показать поле ввода', toggleInputHide: 'Скрыть поле ввода', mainTerminal: 'Основной терминал', newFilterTab: 'Новая вкладка фильтра', filter: 'Фильтр', closeTab: 'Закрыть вкладку', filterText: 'Текст фильтра...', matchCase: 'Учитывать регистр', useRegex: 'Использовать регулярное выражение', sendInputPlaceholder: 'Введите данные для отправки...', send: 'Отправить', autoSendToggle: 'Автоотправка', shortcutSendToggle: 'Отправка с клавиатуры', lastSentNone: 'Последняя отправка: Нет', lastSent: 'Последняя отправка: {value}', connectedTo: '--- Подключено к {path} на скорости {baudRate} ({dataBits}N{stopBits}) ---', failedToConnect: 'Ошибка подключения: {error}', serialDisconnected: 'Последовательный порт отключён', errorPrefix: '[ОШИБКА] {error}', rx: 'RX', tx: 'TX' },
    prefs: { appearance: 'Внешний вид', terminal: 'Терминал', highlighting: 'Подсветка', logging: 'Логирование', about: 'О программе', appearanceSettings: 'Настройки внешнего вида', language: 'Язык', englishFontFamily: 'Шрифт для английского', chineseFallbackFontFamily: 'Китайский/резервный шрифт', fontSize: 'Размер шрифта (px)', textColor: 'Цвет текста', backgroundColor: 'Цвет фона', timestampColor: 'Цвет времени', lineNumberColor: 'Цвет номера строки', terminalSettings: 'Настройки терминала', scrollbackLimit: 'Лимит прокрутки (строки)', scrollbackHelp: 'Максимальное число строк в буфере терминала. Большее значение использует больше памяти.', historyBufferSize: 'Размер буфера истории (символы)', historyBufferHelp: 'Размер буфера истории для новых окон (в символах). Примерно 1 МБ = 1 000 000 символов.', keywordHighlighting: 'Подсветка ключевых слов', addRule: '+ Добавить правило', enableDisable: 'Вкл./Выкл.', regexPlaceholder: 'Regex (например, error)', removeRule: 'Удалить правило', loggingSettings: 'Настройки логирования', enableAutomaticLogging: 'Включить автоматическое логирование', logSavePath: 'Путь сохранения журнала', browse: 'Обзор...', fileNameFormat: 'Формат имени файла', fileNamePlaceholder: 'log_%Y-%m-%d_%H-%M-%S.txt', supportedTags: 'Поддерживаемые теги: %Y, %m, %d, %H, %M, %S', textEncoding: 'Кодировка текста', aboutSerialTerminal: 'О SerialTerminal', version: 'Версия', author: 'Автор', github: 'GitHub', softwareUpdate: 'Обновление программы', currentVersionUpToDate: 'Установлена последняя версия.', checkForUpdates: 'Проверить обновления', restartInstall: 'Перезапустить и установить', resetDefaults: 'Сбросить по умолчанию', openConfigFolder: 'Открыть папку конфигурации', cancel: 'Отмена', saveApply: 'Сохранить и применить', systemFonts: 'Системные шрифты', confirmReset: 'Вы уверены, что хотите сбросить все настройки? Это действие нельзя отменить.', checkingForUpdates: 'Проверка обновлений...', updateAvailable: 'Доступно обновление: {version}. Загрузка...', latestVersion: 'У вас установлена последняя версия.', updateFailedNetwork: 'Не удалось обновить (ошибка сети).', downloadFromGithub: 'Скачать вручную с GitHub', error: 'Ошибка: {message}', downloading: 'Загрузка... {percent}%', updateDownloaded: 'Обновление загружено ({version}). Готово к установке.' },
    languages: { en: 'English', zhCN: '简体中文', zhTW: '繁體中文', fr: 'Français', ru: 'Русский', de: 'Deutsch' }
  },
  'de': {
    appTitle: 'Serielles Terminal', prefsTitle: 'Einstellungen', common: { none: 'Keine', loading: 'Wird geladen...', noHistory: 'Kein Verlauf', emptyContent: 'Leer' },
    main: { selectPort: 'Port auswählen', selectSerialPort: 'Seriellen Port auswählen', refreshPorts: 'Ports aktualisieren', baudRate: 'Baudrate', customBaudRate: 'Baudrate', backToList: 'Zurück zur Liste', connect: 'Verbinden', disconnect: 'Trennen', clearLog: 'Protokoll löschen', clearTerminalOutput: 'Terminalausgabe löschen', disconnected: 'Getrennt', connected: 'Verbunden', settingsTab: 'Einstellungen', searchTab: 'Suche', sendTab: 'Senden', dataBits8: 'Datenbits: 8', dataBits7: 'Datenbits: 7', dataBits6: 'Datenbits: 6', dataBits5: 'Datenbits: 5', stopBits1: 'Stoppbits: 1', stopBits15: 'Stoppbits: 1,5', stopBits2: 'Stoppbits: 2', parityNone: 'Parität: Keine', parityEven: 'Parität: Gerade', parityOdd: 'Parität: Ungerade', parityMark: 'Parität: Mark', paritySpace: 'Parität: Space', encodingUtf8: 'Kodierung: UTF-8', encodingAscii: 'Kodierung: ASCII', encodingHex: 'Kodierung: Hex', encodingGbk: 'Kodierung: GBK', newlineCrlf: 'Zeilenende: CRLF / CRLF', newlineLf: 'Zeilenende: LF / LF', newlineCr: 'Zeilenende: CR / CR', showTime: 'Zeit anzeigen', showLineNo: 'Zeilennr. anzeigen', searchPlaceholder: 'Suchen...', prev: 'Zurück', next: 'Weiter', regex: 'Regex', caseSensitive: 'Groß-/Kleinschreibung', wholeWord: 'Ganzes Wort', autoSend: 'Automatisch senden', autoSendText: 'Automatisch zu sendender Text...', quickSendList: 'Schnellsendeliste', label: 'Bezeichnung', contentMultiLine: 'Inhalt (mehrzeilig)', addToList: '+ Zur Liste hinzufügen', globalSettings: 'Einstellungen', toggleInput: 'Eingabe', toggleInputShow: 'Eingabefeld anzeigen', toggleInputHide: 'Eingabefeld ausblenden', mainTerminal: 'Hauptterminal', newFilterTab: 'Neuer Filter-Tab', filter: 'Filter', closeTab: 'Tab schließen', filterText: 'Filtertext...', matchCase: 'Groß-/Kleinschreibung', useRegex: 'Regulären Ausdruck verwenden', sendInputPlaceholder: 'Zu sendende Daten eingeben...', send: 'Senden', autoSendToggle: 'Automatisch senden', shortcutSendToggle: 'Tastatur senden', lastSentNone: 'Zuletzt gesendet: Keine', lastSent: 'Zuletzt gesendet: {value}', connectedTo: '--- Verbunden mit {path} bei {baudRate} Baud ({dataBits}N{stopBits}) ---', failedToConnect: 'Verbindung fehlgeschlagen: {error}', serialDisconnected: 'Serieller Port getrennt', errorPrefix: '[FEHLER] {error}', rx: 'RX', tx: 'TX' },
    prefs: { appearance: 'Darstellung', terminal: 'Terminal', highlighting: 'Hervorhebung', logging: 'Protokollierung', about: 'Info', appearanceSettings: 'Darstellungseinstellungen', language: 'Sprache', englishFontFamily: 'Englische Schriftart', chineseFallbackFontFamily: 'Chinesische/Ersatz-Schriftart', fontSize: 'Schriftgröße (px)', textColor: 'Textfarbe', backgroundColor: 'Hintergrundfarbe', timestampColor: 'Zeitstempelfarbe', lineNumberColor: 'Farbe der Zeilennummer', terminalSettings: 'Terminaleinstellungen', scrollbackLimit: 'Scrollback-Limit (Zeilen)', scrollbackHelp: 'Maximale Anzahl an Zeilen im Terminalpuffer. Höhere Werte benötigen mehr Speicher.', historyBufferSize: 'Größe des Verlaufsbuffers (Zeichen)', historyBufferHelp: 'Größe des Verlaufsbuffers für neue Fenster (in Zeichen). Ca. 1 MB = 1.000.000 Zeichen.', keywordHighlighting: 'Schlüsselwort-Hervorhebung', addRule: '+ Neue Regel hinzufügen', enableDisable: 'Aktivieren/Deaktivieren', regexPlaceholder: 'Regex (z. B. error)', removeRule: 'Regel entfernen', loggingSettings: 'Protokolleinstellungen', enableAutomaticLogging: 'Automatische Protokollierung aktivieren', logSavePath: 'Speicherpfad für Protokolle', browse: 'Durchsuchen...', fileNameFormat: 'Dateinamensformat', fileNamePlaceholder: 'log_%Y-%m-%d_%H-%M-%S.txt', supportedTags: 'Unterstützte Platzhalter: %Y, %m, %d, %H, %M, %S', textEncoding: 'Textkodierung', aboutSerialTerminal: 'Über SerialTerminal', version: 'Version', author: 'Autor', github: 'GitHub', softwareUpdate: 'Software-Update', currentVersionUpToDate: 'Die aktuelle Version ist auf dem neuesten Stand.', checkForUpdates: 'Nach Updates suchen', restartInstall: 'Neustarten & installieren', resetDefaults: 'Standardwerte wiederherstellen', openConfigFolder: 'Konfigurationsordner öffnen', cancel: 'Abbrechen', saveApply: 'Speichern & anwenden', systemFonts: 'Systemschriftarten', confirmReset: 'Möchten Sie wirklich alle Einstellungen zurücksetzen? Dies kann nicht rückgängig gemacht werden.', checkingForUpdates: 'Suche nach Updates...', updateAvailable: 'Update verfügbar: {version}. Wird heruntergeladen...', latestVersion: 'Sie verwenden die neueste Version.', updateFailedNetwork: 'Update fehlgeschlagen (Netzwerkfehler).', downloadFromGithub: 'Manuell von GitHub herunterladen', error: 'Fehler: {message}', downloading: 'Wird heruntergeladen... {percent}%', updateDownloaded: 'Update heruntergeladen ({version}). Bereit zur Installation.' },
    languages: { en: 'English', zhCN: '简体中文', zhTW: '繁體中文', fr: 'Français', ru: 'Русский', de: 'Deutsch' }
  }
};
function getLanguage(configLanguage) {
  return translations[configLanguage] ? configLanguage : 'en';
}
function interpolate(text, params = {}) {
  return String(text).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
}
function resolveKey(obj, key) {
  return key.split('.').reduce((acc, part) => acc && acc[part], obj);
}
function t(language, key, params = {}) {
  const lang = translations[getLanguage(language)] || translations.en;
  const fallback = translations.en;
  const value = resolveKey(lang, key) ?? resolveKey(fallback, key) ?? key;
  return interpolate(value, params);
}
module.exports = {
  translations,
  getLanguage,
  t
};
