const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { startOfDay, endOfDay, addDays, subMonths, subDays } = require("date-fns");

admin.initializeApp();
const db = admin.firestore();
const storage = admin.storage();
const messaging = admin.messaging();

async function esAdministrador(uid) {
    if (!uid) return false;
    const doc = await db.collection('Admin').where('uidClient', '==', uid).get();
    return !doc.empty;
}

async function borrarImagenStorage(url) {
    if (!url) return;
    try {
        const fileRef = storage.bucket().file(url); 
        await fileRef.delete();
    } catch (error) {
        console.warn(`No se pudo borrar la imagen ${url}:`, error.message);
    }
}

async function guardarNotificacion(uid, titulo, tipo, mensaje, imagen = null) {
    return db.collection('Notificaciones').add({
        uid_usuario: uid,
        titulo,
        tipo,
        mensaje,
        imagen,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

exports.crearEscenario = functions.https.onCall(async (data, context) => {
    if (!(await esAdministrador(context.auth?.uid))) {
        throw new functions.https.HttpsError('permission-denied', 'Solo administradores');
    }

    const { nombre, categoria, sub_categoria, descripcion, especial, tiempo_sesion, lleva_traje, img_principal, list_img } = data;

    return await db.collection('Escenarios').add({
        nombre, categoria, sub_categoria, descripcion, 
        especial: especial || false,
        tiempo_sesion: especial ? null : (tiempo_sesion || 0),
        lleva_traje: lleva_traje || false,
        img_principal, 
        list_img: list_img || [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
});

exports.actualizarEscenario = functions.https.onCall(async (data, context) => {
    if (!(await esAdministrador(context.auth?.uid))) {
        throw new functions.https.HttpsError('permission-denied', 'Solo administradores');
    }

    const { id, ...campos } = data;
    const docRef = db.collection('Escenarios').doc(id);
    const docSnap = await docRef.get();
    
    if (!docSnap.exists) throw new functions.https.HttpsError('not-found', 'Escenario no encontrado');
    const oldData = docSnap.data();

    if (oldData.img_principal && oldData.img_principal !== campos.img_principal) {
        await borrarImagenStorage(oldData.img_principal);
    }

    if (oldData.list_img && campos.list_img) {
        const antiguas = oldData.list_img;
        const nuevas = campos.list_img;
        const eliminar = antiguas.filter(img => !nuevas.includes(img));
        for (const img of eliminar) await borrarImagenStorage(img);
    }

    await docRef.update({
        ...campos,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
});

exports.eliminarEscenario = functions.https.onCall(async (data, context) => {
    if (!(await esAdministrador(context.auth?.uid))) {
        throw new functions.https.HttpsError('permission-denied', 'Solo administradores');
    }

    const { id } = data;
    const docRef = db.collection('Escenarios').doc(id);
    const docSnap = await docRef.get();
    const escenario = docSnap.data();

    if (escenario.img_principal) await borrarImagenStorage(escenario.img_principal);
    if (escenario.list_img) {
        for (const img of escenario.list_img) await borrarImagenStorage(img);
    }

    await docRef.delete();
    return { success: true };
});

exports.consultarEscenarios = functions.https.onCall(async (data, context) => {
    const { limit = 20, lastDocId, terminoBusqueda } = data;
    let query = db.collection('Escenarios');

    if (terminoBusqueda) {
        query = query.where('nombre', '>=', terminoBusqueda)
                     .where('nombre', '<=', terminoBusqueda + '\uf8ff');
    } else {
        query = query.orderBy('createdAt', 'desc');
    }

    if (lastDocId) {
        const lastDoc = await db.collection('Escenarios').doc(lastDocId).get();
        if (lastDoc.exists) query = query.startAfter(lastDoc);
    }

    const snap = await query.limit(limit).get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
});

exports.crearCita = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión');
    const uid = context.auth.uid;
    
    const fechaCita = new Date(data.fecha); 
    const unMesAtras = subMonths(new Date(), 1);
    const rechazosSnap = await db.collection('Citas')
        .where('uid_cliente', '==', uid)
        .where('estado_solicitud', '==', 'rechazada')
        .where('createdAt', '>=', unMesAtras)
        .get();

    if (rechazosSnap.size >= 2) {
        throw new functions.https.HttpsError('failed-precondition', 'No se pueden crear más citas por cancelaciones frecuentes.');
    }

    const inicioDia = startOfDay(fechaCita);
    const finDia = endOfDay(fechaCita);
    const citasHoySnap = await db.collection('Citas')
        .where('uid_cliente', '==', uid)
        .where('fecha', '>=', inicioDia)
        .where('fecha', '<=', finDia)
        .get();

    if (!citasHoySnap.empty) {
        throw new functions.https.HttpsError('already-exists', 'El cliente no puede crear más de una cita el mismo día.');
    }

    const nuevaCita = {
        ...data,
        uid_cliente: uid,
        estado_solicitud: 'espera',
        estado_atendida: 'espera',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    return await db.collection('Citas').add(nuevaCita);
});

exports.actualizarCita = functions.https.onCall(async (data, context) => {
    const { id, ...campos } = data;
    const uid = context.auth.uid;
    const isAdmin = await esAdministrador(uid);

    const citaRef = db.collection('Citas').doc(id);
    const citaSnap = await citaRef.get();
    if(!citaSnap.exists) throw new functions.https.HttpsError('not-found', 'Cita no encontrada');
    
    const citaData = citaSnap.data();

    if (isAdmin) {
        await citaRef.update({
            ...campos,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } else {
        if (citaData.uid_cliente !== uid) {
            throw new functions.https.HttpsError('permission-denied', 'No es tu cita');
        }
        if (Object.keys(campos).length === 1 && campos.estado_solicitud === 'rechazada') {
             await citaRef.update({
                estado_solicitud: 'rechazada',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            throw new functions.https.HttpsError('permission-denied', 'El cliente solo puede cancelar la cita');
        }
    }
    return { success: true };
});

exports.consultarCitas = functions.https.onCall(async (data, context) => {
    const uid = context.auth.uid;
    const isAdmin = await esAdministrador(uid);
    const { uid_cliente_consulta, fecha, limit = 20, lastDocId } = data;

    let query = db.collection('Citas');

    if (isAdmin) {
        if (fecha) {
            const d = new Date(fecha);
            query = query.where('fecha', '>=', startOfDay(d))
                         .where('fecha', '<=', endOfDay(d));
        } else if (uid_cliente_consulta) {
            query = query.where('uid_cliente', '==', uid_cliente_consulta);
        }
    } else {

        query = query.where('uid_cliente', '==', uid)
                     .where('estado_solicitud', '!=', 'rechazada');
    }

    query = query.orderBy('fecha', 'asc');

    if (limit) query = query.limit(limit);
    if (lastDocId) {
        const lastDoc = await db.collection('Citas').doc(lastDocId).get();
        query = query.startAfter(lastDoc);
    }

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

exports.crearOActualizarCliente = functions.https.onCall(async (data, context) => {
    const { provider, providerUserId, name, email, photo } = data;
    const uid = context.auth.uid;

    await db.collection('Clientes').doc(uid).set({
        provider, providerUserId, name, email, photo,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { success: true };
});

exports.eliminarCliente = functions.https.onCall(async (data, context) => {
    const { uid_a_eliminar } = data;
    const uid_solicitante = context.auth.uid;
    const isAdmin = await esAdministrador(uid_solicitante);

    if (uid_a_eliminar !== uid_solicitante && !isAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'No autorizado');
    }

    await db.collection('Clientes').doc(uid_a_eliminar).delete();
    
    return { success: true };
});

exports.consultarClientes = functions.https.onCall(async (data, context) => {
    if (!(await esAdministrador(context.auth?.uid))) throw new functions.https.HttpsError('permission-denied', 'Solo admin');
    
    const { busqueda, limit = 20, lastDocId } = data;
    let query = db.collection('Clientes');

    if (busqueda) {
        query = query.orderBy('name').startAt(busqueda).endAt(busqueda + '\uf8ff');
    } else {
        query = query.orderBy('createdAt', 'desc');
    }

    if (lastDocId) {
        const doc = await db.collection('Clientes').doc(lastDocId).get();
        query = query.startAfter(doc);
    }

    const snap = await query.limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

exports.registrarDispositivo = functions.https.onCall(async (data, context) => {
    const { token_fcm, uid_dispositivo, plataforma } = data;
    const uid_usuario = context.auth ? context.auth.uid : null;

    await db.collection('Dispositivos').doc(uid_dispositivo).set({
        uid_usuario,
        token_fcm,
        plataforma,
        activo: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { success: true };
});

exports.crearSolicitudFotos = functions.https.onCall(async (data, context) => {
    const uid = context.auth.uid;
    const { recibo_url } = data;

    return await db.collection('Solicitudes_Fotos').add({
        uid_cliente: uid,
        recibo_url,
        estado: 'pendiente',
        fotos_urls: [],
        fecha_solicitud: admin.firestore.FieldValue.serverTimestamp(),
        fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
    });
});

exports.actualizarSolicitudAdmin = functions.https.onCall(async (data, context) => {
    if (!(await esAdministrador(context.auth?.uid))) throw new functions.https.HttpsError('permission-denied', 'Solo admin');

    const { id, fotos_urls } = data;
    await db.collection('Solicitudes_Fotos').doc(id).update({
        fotos_urls,
        estado: 'entregado',
        fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
});

exports.eliminarSolicitud = functions.https.onCall(async (data, context) => {
    const { id } = data;
    const uid = context.auth.uid;
    const isAdmin = await esAdministrador(uid);

    const docRef = db.collection('Solicitudes_Fotos').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) return { success: true };
    const solicitud = doc.data();

    if (solicitud.uid_cliente !== uid && !isAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'No autorizado');
    }

    await docRef.delete();
    return { success: true };
});

exports.notificarCambioCita = functions.firestore
    .document('Citas/{citaId}')
    .onUpdate(async (change, context) => {
        const newData = change.after.data();
        const oldData = change.before.data();

        if (newData.estado_solicitud === oldData.estado_solicitud) return null;

        const uid = newData.uid_cliente;
        const titulo = newData.escenario_nombre;
        const tipo = 'Confirmación';
        let mensaje = '';
        
        if (newData.estado_solicitud === 'aceptada') {
            mensaje = `Tu cita para ${newData.escenario_nombre} ha sido confirmada.`;
        } else if (newData.estado_solicitud === 'rechazada') {
            mensaje = `Tu cita para ${newData.escenario_nombre} ha sido rechazada.`;
        } else {
            return null;
        }

        const imagen = newData.escenario_img_principal;

        await guardarNotificacion(uid, titulo, tipo, mensaje, imagen);

        const devices = await db.collection('Dispositivos')
            .where('uid_usuario', '==', uid)
            .where('activo', '==', true)
            .get();
        
        const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);

        if (tokens.length > 0) {
            await messaging.sendEachForMulticast({
                tokens,
                notification: { title: titulo, body: mensaje, image: imagen || "" }
            });
        }
        return null;
    });

exports.notificarNuevoEscenario = functions.firestore
    .document('Escenarios/{escenarioId}')
    .onCreate(async (snap, context) => {
        const escenario = snap.data();

        const devices = await db.collection('Dispositivos').where('activo', '==', true).get();
        const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);

        const payload = {
            notification: {
                title: '¡Nuevo Escenario!',
                body: `Ven a conocer "${escenario.nombre}"`,
                image: escenario.img_principal || ""
            }
        };

        const batchSize = 500;
        const promises = [];
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batchTokens = tokens.slice(i, i + batchSize);
            promises.push(messaging.sendEachForMulticast({
                tokens: batchTokens,
                ...payload
            }));
        }

        await Promise.all(promises);
        return null;
    });

exports.notificarFotosListas = functions.firestore
    .document('Solicitudes_Fotos/{solicitudId}')
    .onUpdate(async (change, context) => {
        const newData = change.after.data();
        const oldData = change.before.data();

        if (newData.estado === 'entregado' && oldData.estado !== 'entregado') {
             const uid = newData.uid_cliente;
             const msg = "Tus fotos ya están disponibles en la app.";
             
             await guardarNotificacion(uid, "Fotos Listas", "Info", msg);

             const devices = await db.collection('Dispositivos').where('uid_usuario', '==', uid).get();
             const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);
             
             if (tokens.length > 0) {
                 await messaging.sendEachForMulticast({
                     tokens,
                     notification: { title: "Fotos Listas", body: msg }
                 });
             }
        }
        return null;
    });

exports.recordatorioDiario = functions.pubsub.schedule('0 9 * * *')
    .timeZone('America/Bogota') 
    .onRun(async (context) => {
        const hoy = startOfDay(new Date());
        const limite = endOfDay(addDays(hoy, 2));

        const citasSnap = await db.collection('Citas')
            .where('fecha', '>=', hoy)
            .where('fecha', '<=', limite)
            .where('estado_solicitud', '==', 'aceptada')
            .get();

        const usuariosANotificar = new Set();
        
        citasSnap.forEach(doc => {
            const cita = doc.data();
            usuariosANotificar.add({
                uid: cita.uid_cliente,
                escenario: cita.escenario_nombre
            });
        });

        for (const user of usuariosANotificar) {
            const devices = await db.collection('Dispositivos').where('uid_usuario', '==', user.uid).get();
            const tokens = devices.docs.map(d => d.data().token_fcm).filter(t => t);
            
            if (tokens.length > 0) {
                await messaging.sendEachForMulticast({
                    tokens,
                    notification: {
                        title: "Recordatorio de Cita",
                        body: `Recuerda tu cita próxima en ${user.escenario}`
                    }
                });
                await guardarNotificacion(user.uid, "Recordatorio", "recordatorio", `Recuerda tu cita próxima en ${user.escenario}`);
            }
        }
        console.log('Recordatorios enviados');
        return null;
    });