// Перехватываем попытку закрытия окна скриптами Valve
window.close = function() {
    console.log("Millennium: Перехвачен window.close(). Перенаправляем на главную.");
    // Безопасный редирект на домашнюю страницу магазина/библиотеки
    window.location.href = 'https://steamcommunity.com/id/NotKuromi/';
};
