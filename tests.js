// open a specific conversation
[...document.querySelectorAll('mws-conversations-list h2 > span')].filter(el => el.innerText == 'Peter Baker')[0].click()

// select all messages and then check if an arb one is incoming or outgoing
document.querySelectorAll('mws-message-part-content')[98].classList.contains('incoming')


document.querySelectorAll('mws-message-part-content')[98].querySelector('.msg-content > div').innerText

// load mroe messages
document.querySelector('mws-bottom-anchored').scrollBy(0, -500)