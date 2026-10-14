/**
 * @description Оптимизированные анимации с виртуализацией списка
 * @version 1.9
 */

// Конфигурация
const ANIMATION_CONFIG = {
    groupTranslate: '8px',
    friendTranslate: '5px',
    groupBgHover: 'rgba(102, 51, 153, 0.5)',
    friendBgHover: 'rgba(255, 255, 255, 0.1)',
    transitionSpeed: '0.3s',
    visibleFriends: 50, // Количество одновременно видимых друзей
    prerender: 10 // Дополнительные элементы для плавного скролла
};

// Глобальные переменные
let animationObserver;
let resizeObserver;
let scrollHandlers = new WeakMap();
let isChatOpen = false;

function initializeFriendsUI() {
    console.log("[Millennium] Initializing optimized animations...");
    
    // Проверка поддержки
    if (!CSS.supports('transition', 'all') || !window.IntersectionObserver) {
        console.warn("[Millennium] Required features not supported");
        return;
    }

    // Создаем/обновляем стили
    const styleId = 'millennium-perf-animations';
    let style = document.getElementById(styleId);
    if (!style) {
        style = document.createElement('style');
        style.id = styleId;
        document.head.appendChild(style);
    }

    // Обновляем содержимое стилей
    style.textContent = `
        /* ОСНОВНЫЕ АНИМАЦИИ */
        .friendGroup {
            transition: transform ${ANIMATION_CONFIG.transitionSpeed} ease, 
                       background-color ${ANIMATION_CONFIG.transitionSpeed} ease !important;
            padding: 8px 12px !important;
            margin-bottom: 10px !important;
            border-radius: 6px !important;
            background: rgba(102, 51, 153, 0.3) !important;
            position: relative !important;
            overflow: hidden !important;
            cursor: pointer !important;
            will-change: transform;
        }
        
        .friendGroup::before {
            content: "" !important;
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 3px !important;
            height: 100% !important;
            background: darkorange !important;
            transition: all ${ANIMATION_CONFIG.transitionSpeed} ease !important;
            z-index: 1 !important;
        }
        
        .friendGroup:hover {
            transform: translateX(${ANIMATION_CONFIG.groupTranslate}) !important;
            background: ${ANIMATION_CONFIG.groupBgHover} !important;
        }
        
        .friendGroup:hover::before {
            background: greenyellow !important;
            width: 5px !important;
        }
        
        .friendGroup .groupName {
            color: darkorange !important;
            font-weight: bold !important;
            text-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;
            padding-left: 15px !important;
            position: relative !important;
            transition: all ${ANIMATION_CONFIG.transitionSpeed} ease !important;
            z-index: 2 !important;
        }
        
        .friendGroup:hover .groupName {
            color: #ffaa00 !important;
            text-shadow: 0 0 5px rgba(255, 170, 0, 0.7) !important;
        }
        
        .friend {
            transition: transform 0.2s ease, 
                       background-color 0.2s ease !important;
            padding: 6px 10px !important;
            border-radius: 4px !important;
            margin: 3px 0 !important;
            will-change: transform;
            content-visibility: auto;
            contain-intrinsic-size: auto 50px;
        }
        
        .friend:hover {
            transform: translateX(${ANIMATION_CONFIG.friendTranslate}) !important;
            background: ${ANIMATION_CONFIG.friendBgHover} !important;
        }
        
        .friendStatus {
            transition: transform ${ANIMATION_CONFIG.transitionSpeed} ease !important;
            will-change: transform;
        }
        
        .friend:hover .friendStatus {
            transform: scale(1.2) !important;
        }
        
        /* ВИРТУАЛИЗАЦИЯ СПИСКА */
        .friends-virtual-container {
            position: relative;
            overflow-y: auto;
            will-change: transform;
            contain: strict;
        }
        
        .friends-virtual-content {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
        }
        
        .friend-virtual-item {
            position: absolute;
            width: 100%;
            will-change: transform, opacity;
        }
    `;

    // Инициализация виртуализации
    setupVirtualization();
    
    // Наблюдатель за открытием/закрытием чата
    setupChatObserver();
    
    console.log("[Millennium] Optimized animations v1.9 initialized");
}

function setupVirtualization() {
    const friendsContainers = document.querySelectorAll('.friends_list');
    
    friendsContainers.forEach(container => {
        if (container.dataset.virtualized) return;
        container.dataset.virtualized = "true";
        
        // Создаем виртуальный контейнер
        const virtualContainer = document.createElement('div');
        virtualContainer.className = 'friends-virtual-container';
        virtualContainer.style.height = container.clientHeight + 'px';
        
        const virtualContent = document.createElement('div');
        virtualContent.className = 'friends-virtual-content';
        virtualContent.style.height = container.scrollHeight + 'px';
        
        // Переносим друзей в виртуальный контейнер
        const friends = Array.from(container.querySelectorAll('.friend'));
        friends.forEach((friend, index) => {
            const virtualItem = document.createElement('div');
            virtualItem.className = 'friend-virtual-item';
            virtualItem.style.height = friend.clientHeight + 'px';
            virtualItem.style.top = (index * friend.clientHeight) + 'px';
            virtualItem.appendChild(friend);
            virtualContent.appendChild(virtualItem);
        });
        
        virtualContainer.appendChild(virtualContent);
        container.innerHTML = '';
        container.appendChild(virtualContainer);
        
        // Сохраняем ссылки на элементы
        container.virtualData = {
            container: virtualContainer,
            content: virtualContent,
            items: friends.map(friend => ({
                element: friend,
                height: friend.clientHeight
            }))
        };
        
        // Настраиваем обработчик скролла
        setupScrollHandler(container);
    });
}

function setupScrollHandler(container) {
    const virtualData = container.virtualData;
    if (!virtualData) return;
    
    const handler = () => {
        const scrollTop = virtualData.container.scrollTop;
        const viewportHeight = virtualData.container.clientHeight;
        
        // Рассчитываем видимый диапазон
        const startIndex = Math.max(0, Math.floor(scrollTop / 50) - ANIMATION_CONFIG.prerender);
        const endIndex = Math.min(
            virtualData.items.length,
            startIndex + ANIMATION_CONFIG.visibleFriends + ANIMATION_CONFIG.prerender * 2
        );
        
        // Показываем только видимые элементы
        virtualData.content.querySelectorAll('.friend-virtual-item').forEach((item, index) => {
            if (index >= startIndex && index < endIndex) {
                item.style.display = '';
                // Обновляем позицию
                let top = 0;
                for (let i = 0; i < index; i++) {
                    top += virtualData.items[i].height;
                }
                item.style.top = top + 'px';
            } else {
                item.style.display = 'none';
            }
        });
        
        // Обновление видимости
        updateVisibility(container, startIndex, endIndex);
    };
    
    // Сохраняем обработчик для последующего удаления
    scrollHandlers.set(virtualData.container, handler);
    
    // Инициализация и подписка на события
    handler();
    virtualData.container.addEventListener('scroll', handler);
    
    // Наблюдатель за изменением размеров
    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(entries => {
            entries.forEach(entry => {
                const container = entry.target.closest('.friends_list');
                if (container && container.virtualData) {
                    container.virtualData.content.style.height = container.virtualData.items.reduce(
                        (sum, item) => sum + item.height, 0
                    ) + 'px';
                    scrollHandlers.get(container.virtualData.container)?.();
                }
            });
        });
    }
    resizeObserver.observe(virtualData.container);
}

function updateVisibility(container, startIndex, endIndex) {
    // Анимация появления/исчезновения
    container.virtualData.content.querySelectorAll('.friend-virtual-item').forEach((item, index) => {
        const friend = item.querySelector('.friend');
        if (!friend) return;
        
        if (index >= startIndex && index < endIndex) {
            friend.style.opacity = '1';
            friend.style.transform = 'translateX(0)';
            friend.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        } else {
            friend.style.opacity = '0';
            friend.style.transform = 'translateX(-10px)';
        }
    });
}

function setupChatObserver() {
    const chatContainer = document.querySelector('.friendsui-container');
    if (!chatContainer) return;
    
    const observer = new MutationObserver(() => {
        const isVisible = getComputedStyle(chatContainer).display !== 'none';
        
        if (isVisible && !isChatOpen) {
            // Чат открыт
            isChatOpen = true;
            resumeVirtualization();
        } else if (!isVisible && isChatOpen) {
            // Чат закрыт
            isChatOpen = false;
            pauseVirtualization();
        }
    });
    
    observer.observe(chatContainer, {
        attributes: true,
        attributeFilter: ['style']
    });
    
    // Инициализация
    isChatOpen = getComputedStyle(chatContainer).display !== 'none';
}

function pauseVirtualization() {
    console.log("[Millennium] Pausing virtualization");
    
    // Приостанавливаем все ресурсоемкие операции
    if (animationObserver) {
        animationObserver.disconnect();
    }
    
    if (resizeObserver) {
        resizeObserver.disconnect();
    }
    
    // Очищаем обработчики скролла
    document.querySelectorAll('.friends-virtual-container').forEach(container => {
        const handler = scrollHandlers.get(container);
        if (handler) {
            container.removeEventListener('scroll', handler);
        }
    });
    
    // Освобождаем память
    scrollHandlers = new WeakMap();
}

function resumeVirtualization() {
    console.log("[Millennium] Resuming virtualization");
    
    // Переинициализируем виртуализацию
    setupVirtualization();
    
    // Восстанавливаем наблюдатель для новых элементов
    setupAnimationObserver();
}

function setupAnimationObserver() {
    if (animationObserver) animationObserver.disconnect();
    
    animationObserver = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1 && node.classList.contains('friend')) {
                        initElementAnimations(node);
                    }
                });
            }
        });
    });
    
    animationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function initElementAnimations(element) {
    if (element.classList.contains('friend')) {
        element.style.transition = 'transform 0.2s ease, background-color 0.2s ease';
    }
}

// Оптимизированный запуск
function delayedInit() {
    // Ждем пока Steam полностью загрузит интерфейс
    if (!document.querySelector('.friendsui-container')) {
        setTimeout(delayedInit, 500);
        return;
    }
    
    initializeFriendsUI();
}

// Запуск
if (document.readyState === 'complete') {
    setTimeout(delayedInit, 1000);
} else {
    window.addEventListener('load', () => setTimeout(delayedInit, 1000));
}