import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'ssh2';
import http from 'http';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// On crée le serveur HTTP en y liant Express et Socket.io
const server = http.createServer(app); 
const io = new Server(server); 

// ==========================================
// CONFIGURATION DE TA FEDORA & DU SITE
// ==========================================
const MOT_DE_PASSE_SITE = "mon_super_mot_de_passe"; 

const CONFIG_SSH = {
  host: "192.168.x.x",       // IP de ta Fedora (ou "127.0.0.1" si le serveur tourne dessus)
  username: "ton_username",  // Utilisateur Fedora
  password: "ton_password",  // Mot de passe Fedora
  port: 22
};

// ==========================================
// CLASSE SSH / SFTP ENRICHIE
// ==========================================
class ServeurDistant {
  constructor(config) {
    this.config = config;
    this.connexion = null;
  }

  connecter() {
    return new Promise((resolve, reject) => {
      this.connexion = new Client();
      this.connexion.on('ready', () => resolve());
      this.connexion.on('error', (err) => reject(err));
      this.connexion.connect(this.config);
    });
  }

  // 1. Lister le contenu d'un dossier
// 1. Lister le contenu d'un dossier via commande shell (beaucoup plus fiable)
  listerDossier(cheminDistant) {
    return new Promise((resolve, reject) => {
      // On utilise 'ls -p' pour lister les dossiers avec un '/' à la fin
      this.connexion.exec(`ls -p "${cheminDistant}"`, (err, stream) => {
        if (err) return reject(err);
        
        let donnees = '';
        stream.on('data', (data) => { donnees += data; });
        stream.on('close', (code) => {
          if (code !== 0) return reject(new Error("Erreur lors de la liste des fichiers"));
          
          // On transforme la chaîne de caractères brute en tableau JSON
          const liste = donnees.split('\n').filter(n => n.length > 0);
          const resultat = liste.map(nom => {
            const estDossier = nom.endsWith('/');
            return { 
              nom: estDossier ? nom.slice(0, -1) : nom, 
              estDossier: estDossier 
            };
          });
          resolve(resultat);
        });
      });
    });
  }

  // 2. Lire le contenu d'un fichier texte
  lireFichier(cheminFichier) {
    return new Promise((resolve, reject) => {
      this.connexion.sftp((err, sftp) => {
        if (err) return reject(err);
        
        const stream = sftp.createReadStream(cheminFichier);
        let donnees = '';
        
        stream.on('data', (chunk) => { donnees += chunk; });
        stream.on('end', () => resolve(donnees));
        stream.on('error', (err) => reject(err));
      });
    });
  }

  // 3. Écrire/Sauvegarder un fichier texte
  ecrireFichier(cheminFichier, contenu) {
    return new Promise((resolve, reject) => {
      this.connexion.sftp((err, sftp) => {
        if (err) return reject(err);
        
        const stream = sftp.createWriteStream(cheminFichier);
        stream.on('close', () => resolve());
        stream.on('error', (err) => reject(err));
        
        stream.write(contenu);
        stream.end();
      });
    });
  }

  // 4. Créer un dossier
  creerDossier(cheminDossier) {
    return new Promise((resolve, reject) => {
      this.connexion.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.mkdir(cheminDossier, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  // 5. Supprimer un fichier
  supprimerFichier(cheminFichier) {
    return new Promise((resolve, reject) => {
      this.connexion.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.unlink(cheminFichier, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  // 6. Supprimer un dossier (vide)
  supprimerDossier(cheminDossier) {
    return new Promise((resolve, reject) => {
      this.connexion.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.rmdir(cheminDossier, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }
}

// Connexion SSH automatique pour le SFTP
const ssh = new ServeurDistant(CONFIG_SSH);
ssh.connecter()
  .then(() => console.log("[SSH] Connecté avec succès au PC Fedora !"))
  .catch(err => console.error("[SSH] Échec de connexion :", err.message));

// ==========================================
// CONFIGURATION SERVEUR WEB (EXPRESS)
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'une_cle_secrete_aleatoire',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

function verifierAuthentification(req, res, next) {
  if (req.session && req.session.estConnecte) return next();
  res.redirect('/login');
}

// --- DOSSIER PUBLIC & PAGES ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.post('/login', (req, res) => {
  if (req.body.motdepasse === MOT_DE_PASSE_SITE) {
    req.session.estConnecte = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});
app.get('/', verifierAuthentification, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==========================================
// ROUTES DE L'API DE GESTION DE FICHIERS
// ==========================================

app.get('/api/fichiers', verifierAuthentification, async (req, res) => {
  const chemin = req.query.chemin || `/home/${CONFIG_SSH.username}`;
  try {
    const fichiers = await ssh.listerDossier(chemin);
    res.json({ succes: true, cheminActuel: chemin, fichiers });
  } catch (err) { res.status(500).json({ succes: false, erreur: err.message }); }
});

app.get('/api/fichier/lire', verifierAuthentification, async (req, res) => {
  const { chemin } = req.query;
  try {
    const contenu = await ssh.lireFichier(chemin);
    res.json({ succes: true, contenu });
  } catch (err) { res.status(500).json({ succes: false, erreur: err.message }); }
});

app.post('/api/fichier/sauvegarder', verifierAuthentification, async (req, res) => {
  const { chemin, contenu } = req.body;
  try {
    await ssh.ecrireFichier(chemin, contenu);
    res.json({ succes: true });
  } catch (err) { res.status(500).json({ succes: false, erreur: err.message }); }
});

app.post('/api/fichier/creer', verifierAuthentification, async (req, res) => {
  const { chemin } = req.body;
  try {
    await ssh.ecrireFichier(chemin, ""); 
    res.json({ succes: true });
  } catch (err) { res.status(500).json({ succes: false, erreur: err.message }); }
});

app.post('/api/dossier/creer', verifierAuthentification, async (req, res) => {
  const { chemin } = req.body;
  try {
    await ssh.creerDossier(chemin);
    res.json({ succes: true });
  } catch (err) { res.status(500).json({ succes: false, erreur: err.message }); }
});

app.post('/api/supprimer', verifierAuthentification, async (req, res) => {
  const { chemin, estDossier } = req.body;
  try {
    if (estDossier) {
      await ssh.supprimerDossier(chemin);
    } else {
      await ssh.supprimerFichier(chemin);
    }
    res.json({ succes: true });
  } catch (err) { res.status(500).json({ succes: false, erreur: err.message }); }
});

// ==========================================
// GESTION DU TERMINAL VIA SSH (SOCKET.IO)
// ==========================================
io.on('connection', (socket) => {
  console.log('[Terminal-SSH] Nouvelle demande de connexion au terminal');

  // On crée un client SSH dédié pour cette session de terminal
  const connTerminal = new Client();

  connTerminal.on('ready', () => {
    // On demande d'ouvrir un shell interactif (un pseudo-tty)
    connTerminal.shell({ term: 'xterm-color', cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        socket.emit('output', `\r\n*** Erreur de création du shell SSH : ${err.message} ***\r\n`);
        return connTerminal.end();
      }

      // Quand la Fedora renvoie des caractères via SSH -> on les pousse au navigateur
      stream.on('data', (data) => {
        socket.emit('output', data.toString());
      });

      // Quand la Fedora ferme le shell SSH
      stream.on('close', () => {
        socket.emit('output', '\r\n*** Session SSH fermée ***\r\n');
        connTerminal.end();
      });

      // Quand l'utilisateur tape une touche sur le navigateur -> on l'envoie à la Fedora via SSH
      socket.on('input', (data) => {
        stream.write(data);
      });

      // Si l'utilisateur ferme l'onglet/se déconnecte
      socket.on('disconnect', () => {
        console.log('[Terminal-SSH] Déconnexion utilisateur, fermeture du shell');
        connTerminal.end();
      });
    });
  });

  connTerminal.on('error', (err) => {
    socket.emit('output', `\r\n*** Erreur de connexion SSH : ${err.message} ***\r\n`);
  });

  // On lance la connexion SSH pour ce client précis
  connTerminal.connect(CONFIG_SSH);
});

// ==========================================
// DÉMARRAGE DU SERVEUR
// ==========================================
server.listen(PORT, () => {
  console.log(`[SERVEUR] Dashboard et Terminal SSH démarrés sur http://localhost:${PORT}`);
});
