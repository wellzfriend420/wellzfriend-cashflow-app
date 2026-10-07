'use strict';
document.getElementById('loginForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('button'),error=document.getElementById('loginError');button.disabled=true;error.textContent='';
  try{const res=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});const data=await res.json();if(!res.ok)throw new Error(data.error||'ログインできませんでした');location.replace('/');}
  catch(e){error.textContent=e.message;}finally{document.getElementById('password').value='';button.disabled=false;}
});
